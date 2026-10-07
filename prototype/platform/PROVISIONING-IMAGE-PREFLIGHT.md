# Existing pinned-image preflight

The private `createProvisioningImagePreflight` capability resolves the two exact
reviewed image references from an original branded, claimed preparation into
local Docker configuration IDs. It does not accept alternative tags, image
references or an unbranded object supplied by a request.

It first checks the local default daemon context, then issues only two fixed
read-only image-inspection commands. Each image must already exist, report the
exact requested repository digest, have a canonical configuration ID and target
Linux/amd64. The restaurant image must retain UID/GID10001:10001. Runtime and
PostgreSQL configuration IDs must differ. Responses are bounded and private
errors are sanitized. Cancellation, missing images or ambiguous metadata fail
closed without a registry login, pull, build, tagging operation or retry.

Exact repository names matter: the reviewed release must use the same canonical
repository digest recorded by Docker. This component does not guess registry
aliases. A configuration ID is not a registry digest; the returned frozen map is
for the runtime observer's expected local identities, not a publication receipt.

The caller still owns current journal fencing, host exclusion, manifest/secret
checks and release approval. A digest match is not signature verification, a
vulnerability assessment, proof of provenance or runtime acceptance. The current
original codec-bearing build supports the explicitly checked amd64 target;
other architectures need their own reviewed build and acceptance.

Four local groups use the actual compiler/preparation capability and a simulated
bounded Docker transport: exact commands and output binding, identity/platform/
digest/user rejection, copied preparations, cancellation/foreign context, malformed
or oversized responses and sanitized missing-image failures. This does not claim
actual registry publication or daemon acceptance of production-pinned releases.
