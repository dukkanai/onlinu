# Isolated runtime image acceptance

The explicitly enabled `runtime-image` job in `ci.yml` builds the original root
Dockerfile, including the pinned external Opus/MLow source, and runs only
synthetic image acceptance. It does not publish a registry image or deploy any
production container. Running external codec source still requires the owner's
specific approval; merely adding this workflow does not establish that approval
or successful execution. It runs only on manual dispatch with the
`runtime_image` boolean input explicitly true; the default is false, and pushes
or pull requests cannot enable the job.

`integration/runtime-image-smoke.sh` requires an ephemeral GitHub Actions runner
and an image tagged with the exact source commit. It ignores inherited remote
Docker configuration, refuses pre-existing test names, and cleans up only
resources it successfully created. It never prunes Docker or enumerates existing
containers for deletion. Synthetic fixture files are disposable and contain no
production credentials.

Planned checks:

- Build the existing client and codec-bearing Go runtime using its original tests.
- Check the shipped codec shared object and executable linkage.
- Start one disposable PostgreSQL instance on an internal test network, without
  published database ports. Its bootstrap secret is not mounted in the runtime.
- Bootstrap a synthetic `LOGIN`/`CREATEDB` role without superuser, role-management,
  replication or RLS bypass, then run the image as its existing UID 10001.
- Use read-only secret file mounts, read-only root, dropped capabilities and a
  temporary filesystem, with an owned disposable media volume.
- Check health and the original administrator API's rejection/acceptance paths,
  actual database ownership and absence of fixture secrets in runtime logs.

HTTP is probed through the owned container’s loopback interface; neither
runtime nor PostgreSQL publishes a host port. No WhatsApp client, pairing,
message, real call, payment, provider account or production data is used. A
successful report records the source commit and local image ID; that image ID is
not a published registry digest. Raw logs and secret files are not uploaded. Failed startup emits only a
bounded diagnostic tail with fixture credentials and database URLs redacted.

Local evidence includes shell syntax and six fake-Docker safety checks,
alongside all 51 deployment/packaging tests. The revised guards exercise a
successful internal HTTP probe and redacted early-exit diagnostics without Docker. Ordinary CI37409249616 passed for
`d25f00a`; the image job was explicitly skipped. These checks do not build or run
the image. The opt-in image job outcome must be recorded before claiming
runtime image acceptance. Real calls, provider integration, multi-tenant network
isolation, production routing, registry publication and release approval remain
separate gates.

First approved run CI37421243686 built the original image successfully, then
stopped in the test harness while looking up a missing host port binding on the
internal network. The revised harness removes host publication entirely and
probes inside the owned runtime container, with explicit startup diagnostics.
Full image acceptance remains pending a successful revised run.
