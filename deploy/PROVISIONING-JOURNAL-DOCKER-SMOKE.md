# Real journal plus disposable Docker tenant lifecycle

This opt-in GitHub fixture joins the actual PostgreSQL identity/provisioning
journal, authoritative Python compiler, immutable artifact preflight, exclusive
stager, Linux host lock and bounded command transport to real disposable Docker
restaurant instances. It is an integration acceptance driver, not the production
apply/verify implementation.

The workflow requires `runtime_image=true`, the exact codec-bearing image built
for the commit, and a fresh loopback-only PostgreSQL16 CI service. Database URL
validation permits only the named CI identity database and public test credential.
The script creates an owned random schema and synthetic operator/owner identities;
this does not establish real OIDC or operator enrollment.

## Cases

1. A fresh reviewed intent claims, stages, starts and verifies a synthetic tenant,
   then records success through the actual journal. The tenant remains draft.
2. Another fresh tenant starts successfully but the fixture deliberately loses
   the apply reply. The coordinator retains `unknown`. An attempted replay is
   rejected before another apply. The trusted fixture separately inspects the
   actual owned healthy runtime and administrator authentication, then explicitly
   reconciles with evidence. Apply count remains exactly one.

Artifacts are compiled and staged without changing their original bytes. The
fixture then writes a separate CI-only Compose copy overriding image references
and host synthetic secret/config paths, as in the existing two-tenant smoke.
These overrides are explicitly reported; production registry-digest and real
secret-provisioning acceptance are not implied. No real credentials, provider
accounts, calls, orders, payments or production hosts are used.

Each runtime is checked for exact tenant/plan/project ownership, expected local
image ID, UID10001, read-only root, capability restrictions, no-new-privileges,
loopback-only runtime ingress, no published database port, no Docker socket and
no raw secret environment. Health and correct/wrong administrator-key responses
are inspected before journal reconciliation. Existing resources cannot be adopted
by preflight, and a changed fixture manifest cannot be used for cleanup.

## Cleanup and evidence

Cleanup is confined to the exact fresh fixture projects after ownership checks.
Only their named volumes/networks are removed; no prune, wildcard or orphan
cleanup is used. Absence is checked afterward. The owned random database schema
is dropped only when Docker cleanup is confirmed. A cleanup failure retains
available staged/journal evidence and prevents a success report.

The report `onlinu-journal-docker-report.json` joins the exact-commit runtime-image
artifact. Successful fixture acceptance still does not establish a production
apply driver, real credential mounting, registry provenance, external identity,
public routing, backup/restore or real calling. Those remain release gates.

Local pure guards verify database scope, ownership and runtime constraints;
64 deployment tests and286 platform tests without skips plus related actual-main
Go race checks pass. First CI37449963742 reached the new fixture but rejected its noncanonical
synthetic identity issuer before tenant creation. The fixture now uses the exact
canonical issuer required by the existing identity directory, with a regression
guard. Reconciliation also holds the host lock while inspecting exact container
IDs and recording evidence. Corrected real Docker acceptance is pending.
