# Bounded private host-command transport

`createProvisioningProcess` captures a trusted absolute executable, working
directory, timeout and combined output bound. Its `run(args, { signal? })` uses
argument-vector spawning without a shell and with only a minimal PATH/LANG
environment. It is a private building block, not an HTTP command endpoint or
permission to run arbitrary input. The future concrete driver must own and
allowlist its executable and exact command grammar; never pass restaurant data
as a command or credentials as arguments.

No secrets, cloud credentials, NODE_OPTIONS, proxy settings, Docker context or
user HOME are inherited. Stdout is returned only on a successful zero exit and
valid UTF-8. Stderr is drained and counted toward the same limit, never included
in a thrown error. Spawn failures, nonzero exits and cancellation use fixed labels
without command arguments, paths or output.

On Linux each command is started in its own process group. Abort, timeout or
output overflow sends SIGKILL once to that owned group, then waits for the child
`close` event before settling. It never accepts a caller-provided PID, retries a
command or starts unreferenced background work. See [Node child-process session
and close semantics](https://nodejs.org/api/child_process.html#optionsdetached).

This is not a sandbox for hostile executables. A trusted command must not escape
its process group, start detached descendants or leave unrelated background work.
The wrapper cannot revoke an operation already submitted to the Docker daemon,
prove remote cancellation, or recover an uninterruptible kernel operation. The
provisioning journal must retain uncertainty after interruption; client death is
not evidence that resources were not created. The host-lock callback must await
this promise and any other owned work before it returns.

Tests invoke only the installed Node executable with synthetic scripts: explicit
literal arguments, no inherited marker secret, bounded combined output, invalid
UTF-8, sanitized errors, pre/live abort, and timeout of a real parent/descendant
process group. The descendant stops writing its owned temporary marker before
the rejected result is observed. No Docker daemon or production host is invoked.
This does not supply the remaining inspect/apply/verify driver.

Local platform verification passes 282 tests without skips, including host-lock
retention during command timeout, plus related actual-main Go race checks.
Commit `28709b0` passed all four ordinary jobs in
[CI37440216640](https://github.com/dukkanai/onlinu/actions/runs/37440216640).
The optional unchanged runtime-image job was intentionally skipped.
