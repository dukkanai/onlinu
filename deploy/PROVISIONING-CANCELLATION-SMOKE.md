# Client cancellation versus Docker daemon state

This opt-in isolated GitHub acceptance complements the private process and host
lock tests. It requires `workflow_dispatch` with `runtime_image=true`, the exact
built `onlinu-runtime-smoke:$GITHUB_SHA` image, an ephemeral run context and the
local default Unix Docker socket. It never invokes production, publishes a
registry, reads real credentials or uses remote Docker contexts.

The script creates one fresh randomly named container with exact run/source/nonce
ownership labels. It has no mounts, secrets or published ports, uses network none,
UID10001, read-only root, dropped capabilities and no-new-privileges. It is never
started. The [Docker create command](https://docs.docker.com/reference/cli/docker/container/create/)
creates a daemon object without starting its process; image pulls are disabled.

A trusted synthetic command writes a completion marker after that create, then
intentionally hangs before returning its result to the caller. The parent proves
host exclusion, aborts and awaits its owned process group, and inspects the exact
container again. One retained object demonstrates why a killed client cannot be
interpreted as a rollback or as permission to retry creation. No creation retry
is performed. The host lock is held until the command settles on failure paths too.

Cleanup checks canonical ID, exact name, image identity, all ownership labels and
inert/mount-free constraints before removing that single object by ID. It never
uses force, volume deletion, prune, wildcard removal or guessed ownership. A
cleanup failure prevents a success report; no broader removal is attempted.

Successful evidence is a non-secret `onlinu-provisioning-cancellation-report.json`
in the exact-commit runtime-image artifact. It is separate from the existing
runtime and two-tenant reports. This does not prove a production apply driver,
end-to-end journal/Docker integration, remote daemon cancellation, real secret
mounts or production recovery. Those remain distinct acceptance requirements.

Local: three pure context/ownership/inertness guard tests and all64 deployment
Python tests pass. Commit `7dbde99` passed all five jobs in
[CI37446321930](https://github.com/dukkanai/onlinu/actions/runs/37446321930).
The exact-commit cancellation report was downloaded and inspected, together
with the original runtime and two-tenant reports. All declared cancellation
checks and exact owned cleanup passed; the production exclusions above remain.
