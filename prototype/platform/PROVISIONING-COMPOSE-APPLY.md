# Single-attempt private Compose transport

`createProvisioningComposeApply` makes one bounded creation attempt through the
existing trusted process capability. It has no public route and grants no
operator, daemon or credential access. The driver must already hold host-wide
exclusion, own a live journal claim, supply an authoritative `verifyExecution`
capability and check existing resources through `assertEmpty`.

The transport checkpoints live authority, verifies the manifest reference,
confirms the local default Docker context, validates Compose configuration,
checks authority/integrity again, verifies an empty resource namespace, then
checkpoints and verifies once more before issuing the fixed creation command:
`up --wait --wait-timeout 90 --pull never --no-build`. The process capability
supplies no shell or inherited environment. Manifest paths must be absolute and
stable within the attempt. The source capability must verify exact file bytes
and approved secret references; accepting a path alone is not authorization.

Each transport instance is permanently spent after its first attempt, including
an unsuccessful preflight. It never retries, adopts, updates, removes or activates
resources. Cancellation or a lost reply may leave daemon effects; errors are
sanitized and the existing runner records uncertainty for explicit inspection.
`commandCompleted` is not verification evidence or permission to activate a
tenant. The shared runtime probe and authenticated HTTP checks still must pass.
The journal and exclusive stage prevent reconstructing an instance to replay an
already-attempted job. Cross-process exclusion and reconciliation remain external
requirements, not guarantees from this in-memory object.

The runtime probe now also supplies `assertEmpty`: any project container or exact
planned volume/network name collision is rejected, even without ownership labels.
Unrelated resource names are not returned. Malformed or oversized inventories
fail closed; no conflicting resource is modified or silently adopted.

The real journal/Docker acceptance fixture now uses both components. Its manifest
capability explicitly verifies a synthetic copy with CI-only image/path overrides;
this does not claim a production manifest/secret supplier. Cleanup remains its
separate ownership-verified fixture step, not an apply failure handler.

Four apply-transport groups and four additional empty-namespace groups pass
locally, including lost replies, path changes, revoked authority, wrong context,
foreign collisions and cancellation. Actual daemon acceptance for this increment
is pending. No production host or credential was used.

Compose transport acceptance: `5d973314e5f8c794328a96ccd7f89249c3723ce9`
passed all five jobs in CI37545039166. The already-running job completed after
the user reported a near-exhausted Actions allowance; no later run was dispatched.
Four exact-source runtime reports were inspected and both receipt hashes and
bindings independently checked on 2026-10-06 23:24 UTC. Actual isolated creation,
lost-reply reconciliation and owned cleanup passed. Synthetic local image ID:
`sha256:6cc3a1a4d88a26cb434865c671c8b9336a04958e02d5aa7aac856b7732bf62d4`.
Production manifest/secret supply, routing, activation and release remain open.
