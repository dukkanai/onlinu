"""Pure, non-executable tenant resource planning; never accesses Docker or secrets."""
import base64
import hashlib
import ipaddress
import json
import re
import sys
from urllib.parse import urlsplit

MAX_INPUT_BYTES = 262144
TENANT_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
IMAGE = re.compile(r"[a-z0-9][a-z0-9./:_-]{0,240}@sha256:[a-f0-9]{64}\Z")
FIELDS = {"tenantId", "runtimeImage", "postgresImage", "httpPort", "publicOrigin", "platformIssuer", "platformPublicKey"}


class PlanError(ValueError):
    """Errors are fixed labels and never echo rejected input."""


def origin(value):
    if not isinstance(value, str) or len(value) > 253 or not value.isascii():
        raise PlanError("invalid_https_origin")
    try:
        parsed = urlsplit(value)
        port = parsed.port
        host = parsed.hostname
        if (parsed.scheme != "https" or not host or parsed.username is not None
                or parsed.password is not None or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment or port not in (None, 443)
                or any(c.isspace() or ord(c) < 32 for c in value)
                or "\\" in value or "%" in value or "?" in value or "#" in value):
            raise ValueError()
        # Plans use DNS origins; literal addresses/localhost are not public TLS
        # deployment identities. No DNS resolution or network request is made.
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError()
        if (host == "localhost" or "." not in host or host.endswith(".")
                or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                       for label in host.split("."))):
            raise ValueError()
        return "https://" + host
    except ValueError:
        raise PlanError("invalid_https_origin") from None


def pinned_image(value):
    if not isinstance(value, str) or not IMAGE.fullmatch(value):
        raise PlanError("digest_pinned_image_required")
    repository = value.split("@", 1)[0]
    if ".." in repository or "//" in repository or repository.endswith(("/", ":")):
        raise PlanError("invalid_image_reference")
    return value


def plan_tenant(config):
    if not isinstance(config, dict) or set(config) != FIELDS:
        raise PlanError("invalid_tenant_plan_fields")
    tenant = config["tenantId"]
    if not isinstance(tenant, str) or not TENANT_ID.fullmatch(tenant):
        raise PlanError("invalid_tenant_id")
    port = config["httpPort"]
    if type(port) is not int or not 1024 <= port <= 65535:
        raise PlanError("invalid_loopback_http_port")
    public_origin = origin(config["publicOrigin"])
    issuer = origin(config["platformIssuer"])
    public_key = config["platformPublicKey"]
    try:
        if not isinstance(public_key, str) or len(public_key) != 44:
            raise ValueError()
        decoded = base64.b64decode(public_key, validate=True)
        if len(decoded) != 32 or base64.b64encode(decoded).decode() != public_key:
            raise ValueError()
    except ValueError:
        raise PlanError("invalid_platform_public_key") from None
    resource = "onlinu-" + hashlib.sha256(tenant.encode()).hexdigest()[:32]
    secrets = {name: resource + "-" + suffix for name, suffix in (
        ("WACALLS_API_KEY_FILE", "admin-key"),
        ("WACALLS_PG_URL_FILE", "runtime-pg-url"),
        ("WACALLS_META_ENCRYPTION_KEY_FILE", "meta-key"),
    )}
    plan = {
        "schemaVersion": 1,
        "kind": "onlinu-tenant-resource-plan",
        "executable": False,
        "tenantId": tenant,
        "projectName": resource,
        "runtime": {
            "image": pinned_image(config["runtimeImage"]),
            "uid": 10001,
            "readOnlyRoot": True,
            "capDrop": ["ALL"],
            "noNewPrivileges": True,
            "httpBinding": {"host": "127.0.0.1", "port": port, "containerPort": 8080},
            "environment": {"WACALLS_PLATFORM_TENANT_ID": tenant,
                            "WACALLS_PLATFORM_ISSUER": issuer,
                            "WACALLS_PLATFORM_PUBLIC_KEY": public_key,
                            "WACALLS_PUBLIC_BASE_URL": public_origin,
                            "WACALLS_RECORDING_DIR": "/data/recordings"},
            "secretReferences": secrets,
            "mediaVolume": resource + "-media",
        },
        "postgres": {
            "image": pinned_image(config["postgresImage"]),
            "dedicatedInstance": True,
            "publishedPorts": [],
            "volume": resource + "-postgres",
            "runtimeRole": {"login": True, "createdb": True, "superuser": False,
                            "createrole": False, "replication": False, "bypassrls": False},
            "bootstrapSecretReference": resource + "-pg-bootstrap",
        },
        "networks": {"database": resource + "-database", "runtimeEgress": resource + "-egress"},
        "requiredAcceptance": ["trusted-executor", "approved-existing-secret-mounts",
                               "restricted-role-bootstrap", "dedicated-network-isolation",
                               "image-provenance-and-runtime-smoke", "https-proxy-routing", "live-port-availability",
                               "media-ingress-if-calls-enabled", "resource-capacity",
                               "backup-and-rollback", "production-approval"],
    }
    # Canonical digest is a review/reconciliation identity, not an authorization.
    plan["planDigest"] = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return plan


def plan_fleet(configs):
    if not isinstance(configs, list) or not 1 <= len(configs) <= 1000:
        raise PlanError("invalid_tenant_plan_list")
    plans = [plan_tenant(config) for config in configs]
    for values in ([p["tenantId"] for p in plans], [p["projectName"] for p in plans],
                   [p["runtime"]["httpBinding"]["port"] for p in plans],
                   [p["runtime"]["environment"]["WACALLS_PUBLIC_BASE_URL"] for p in plans]):
        if len(set(values)) != len(values):
            raise PlanError("duplicate_tenant_resource")
    return sorted(plans, key=lambda p: p["tenantId"])


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PlanError("duplicate_input_field")
        result[key] = value
    return result


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise PlanError("plan_input_too_large")
        configs = json.loads(raw, object_pairs_hook=unique_fields)
        print(json.dumps(plan_fleet(configs), ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except (ValueError, UnicodeError, RecursionError) as exc:
        print(str(exc) if isinstance(exc, PlanError) else "invalid_plan_json", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
