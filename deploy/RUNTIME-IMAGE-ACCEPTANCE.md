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

The public HTTP test port binds only to loopback. No WhatsApp client, pairing,
message, real call, payment, provider account or production data is used. A
successful report records the source commit and local image ID; that image ID is
not a published registry digest. Raw logs and secret files are not uploaded.

Local evidence includes shell syntax and four fake-Docker safety checks,
alongside all 49 deployment/packaging tests. Ordinary CI37409249616 passed for
`d25f00a`; the image job was explicitly skipped. These checks do not build or run
the image. The opt-in image job outcome must be recorded before claiming
runtime image acceptance. Real calls, provider integration, multi-tenant network
isolation, production routing, registry publication and release approval remain
separate gates.
