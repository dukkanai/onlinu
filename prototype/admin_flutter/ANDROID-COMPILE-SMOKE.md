# Opt-in Android debug compilation

The CI `android_smoke` input prepares an isolated Android project from the exact
checksum-verified official Flutter3.47.5 templates, then copies the reviewed Dart
application, tests and dependency lock into it. It never overwrites the existing
Windows project or runs a code-writing agent. The source repository remains the
input; generated SDK paths, Gradle caches and signing files are not committed.

The job runs only when manually selected on a standard Linux runner. It analyzes
and tests the copied Dart code and compiles an arm64 debug APK with the reserved
`https://control.invalid` origin. No real account, API endpoint or phone is used.
The package is deliberately `dev.synthetic.restaurant_admin_prototype`, labeled
Onlinu Android Smoke, not a final publisher identity. Android debug signing uses
only the ephemeral runner's ordinary debug build material; no release key or
store account is configured or retained.

The generated main manifest disables Android backup and cleartext traffic and
requires Internet access. The compiled manifest is independently decoded with
the runner's existing APK analyzer and checked for those settings, the expected
package and the debug flag. The archive must contain the selected arm64 Flutter
engine only. A hash-bound JSON report and debug APK are retained for three days;
no key, local.properties, Gradle cache or source credential is uploaded.

The script does not accept a new Android SDK license agreement or run
`--android-licenses`. A missing required SDK/license/analyzer is a build blocker,
not permission to create accounts or accept terms automatically. It uses the
hosted runner's preinstalled SDK and existing accepted configuration.

This gate proves compilation only after CI succeeds. It does not prove Android
rendering, secure-storage behavior, file picking, browser login, lifecycle,
background notifications or physical-device operation. The current native login
client remains Windows-specific; no Android production audience is enabled by
this build. iOS, final application identity, release signing and store delivery
remain separate work. The generated Android scaffold is a reproducible test
workspace, not yet a checked-in shipping Android runner.

Four local Python guard groups pass. Local official SDK download/checksum and
extraction succeeded; local Flutter-tool bootstrap dependency restoration timed
out, so scaffold generation and actual Android compilation are pending CI.
