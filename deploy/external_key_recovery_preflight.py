"""Offline comparison of ID-only recovery declarations, never a restore tool.

No database, archive, keyring, environment configuration or network is opened.
Matching declarations do not authenticate a key, archive, identity or target.
"""
import json
import os
from pathlib import Path
import re
import stat
import sys

MAX_DOCUMENT_BYTES = 64 * 1024
MANIFEST_KIND = "onlinu-external-key-recovery-manifest"
TARGET_KIND = "onlinu-external-key-recovery-target"
COMMON_FIELDS = {"version", "kind", "cryptoMode", "storeId", "databaseName", "schemaName"}
ENVELOPE_FIELDS = {"version", "storeId", "purpose", "dataKeyId", "wrappingKeyId"}
DATA_KEYS = {"order-secrets": "order-dek-v1", "payment-secrets": "payment-dek-v1"}


class RecoveryPreflightError(ValueError):
    """Static diagnostics only; never include a path or rejected input."""


def _reject(label):
    raise RecoveryPreflightError(label)


def _object(value, fields):
    if type(value) is not dict or set(value) != fields:
        _reject("invalid_recovery_fields")


def _version(value):
    if type(value) is not int or value != 1:
        _reject("unsupported_recovery_version")


def _key_id(value, limit):
    # Matches restaurantKeyIdentifier, including its ASCII and leading rule.
    if type(value) is not str or not 1 <= len(value) <= limit or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", value):
        _reject("invalid_recovery_identifier")


def _sql_name(value):
    # Matches restaurantCryptoSQLName. Do not normalize case or rename targets.
    if type(value) is not str or not re.fullmatch(r"[A-Za-z0-9_]{1,63}", value):
        _reject("invalid_recovery_database_identity")


def _identity(value, kind):
    _version(value["version"])
    if value["kind"] != kind or value["cryptoMode"] != "external-v1":
        _reject("unsupported_recovery_format")
    _key_id(value["storeId"], 80)
    _sql_name(value["databaseName"])
    _sql_name(value["schemaName"])


def compare_recovery_metadata(manifest, target):
    """Compare untrusted declarations; no external state or key bytes checked.

    The source manifest omits nonce/ciphertext/key bytes by design. A target's
    key-ID list is an inventory declaration, not evidence of usable key custody.
    """
    _object(manifest, COMMON_FIELDS | {"stateVersion", "envelopes"})
    _object(target, COMMON_FIELDS | {"availableWrappingKeyIds"})
    _identity(manifest, MANIFEST_KIND)
    _identity(target, TARGET_KIND)
    _version(manifest["stateVersion"])
    for field in ("storeId", "databaseName", "schemaName"):
        if manifest[field] != target[field]:
            _reject("recovery_identity_mismatch")

    envelopes = manifest["envelopes"]
    if type(envelopes) is not list or len(envelopes) != 2:
        _reject("invalid_recovery_envelope_inventory")
    purposes, wrapping_ids = set(), set()
    for envelope in envelopes:
        _object(envelope, ENVELOPE_FIELDS)
        _version(envelope["version"])
        purpose = envelope["purpose"]
        if (type(purpose) is not str or purpose not in DATA_KEYS or purpose in purposes
                or envelope["dataKeyId"] != DATA_KEYS[purpose]
                or envelope["storeId"] != manifest["storeId"]):
            _reject("invalid_recovery_envelope_identity")
        _key_id(envelope["wrappingKeyId"], 64)
        purposes.add(purpose)
        wrapping_ids.add(envelope["wrappingKeyId"])
    if len(wrapping_ids) != 1:
        _reject("split_recovery_wrapping_generation")

    available = target["availableWrappingKeyIds"]
    if type(available) is not list or not 1 <= len(available) <= 16:
        _reject("invalid_recovery_key_inventory")
    for key_id in available:
        _key_id(key_id, 64)
    if len(set(available)) != len(available):
        _reject("duplicate_recovery_key_identifier")
    if not wrapping_ids.issubset(available):
        _reject("required_recovery_key_identifier_missing")

    # Fixed output intentionally does not echo caller-controlled IDs or paths.
    return {
        "version": 1,
        "status": "declarations-compatible",
        "executable": False,
        "restoreVerified": False,
        "comparedDeclarations": ["store-database-schema-identity", "external-v1-state-and-envelope-ids",
                                 "same-wrapping-generation", "retained-wrapping-key-ids"],
        "notVerified": ["declaration-authenticity", "archive-integrity-and-completeness", "key-bytes-and-custody",
                        "target-ownership-emptiness-and-isolation", "database-roles-and-settings",
                        "envelope-and-payload-authentication", "cold-start-and-provider-isolation",
                        "business-data-and-sequences", "media-and-cross-resource-consistency",
                        "independent-off-host-recovery", "retention-rpo-rto", "execution-approval"],
    }


def parse_document(raw):
    if type(raw) is not bytes or not 0 < len(raw) <= MAX_DOCUMENT_BYTES:
        _reject("invalid_recovery_document")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                _reject("duplicate_recovery_field")
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                           parse_constant=lambda _: _reject("invalid_recovery_document"))
    except (ValueError, UnicodeError, RecursionError):
        _reject("invalid_recovery_document")
    if type(value) is not dict:
        _reject("invalid_recovery_document")
    return value


def read_document(path):
    """Bounded explicit-file input only; refuse links and non-regular files."""
    try:
        before = Path(path).lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_DOCUMENT_BYTES:
            _reject("invalid_recovery_input_file")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if (not stat.S_ISREG(opened.st_mode) or not os.path.samestat(before, opened)
                    or opened.st_size > MAX_DOCUMENT_BYTES):
                _reject("invalid_recovery_input_file")
            raw = stream.read(MAX_DOCUMENT_BYTES + 1)
    except (OSError, ValueError):
        _reject("invalid_recovery_input_file")
    return parse_document(raw)


def main(args=None):
    args = sys.argv[1:] if args is None else args
    if args == ["--help"]:
        print("Usage: external_key_recovery_preflight.py MANIFEST_JSON TARGET_JSON\n"
              "Compare ID-only declarations offline. Never pass keyrings, credentials or archives.\n"
              "Success is not authentication, restore readiness or permission to execute.")
        return 0
    if len(args) != 2:
        print("recovery_preflight_requires_two_metadata_files", file=sys.stderr)
        return 2
    try:
        result = compare_recovery_metadata(read_document(args[0]), read_document(args[1]))
    except RecoveryPreflightError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
