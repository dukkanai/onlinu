# Opt-in iOS Simulator compilation

The manual CI `ios_smoke` input uses a standard macOS runner, the existing Xcode
toolchain and the exact official Flutter3.47.5 SDK for the detected runner CPU.
Both archive checksums came from the official release metadata at
https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json
and are checked before extraction. No larger/paid runner is selected.

An isolated iOS project is generated from those SDK templates, then receives the
reviewed Dart source, tests and unchanged dependency lock. Existing Windows
sources are not replaced. The temporary package identity is deliberately
`dev.synthetic.restaurantAdminPrototype`, labeled Onlinu iOS Smoke. It is not a
registered App Store identity or an application configured for real accounts.

Analysis and unit/widget tests precede an iOS Simulator debug build with
`--no-codesign` and the reserved `https://control.invalid` origin. The built
Info.plist must identify the Simulator platform and expected package, retain
restricted transport settings and disable app document sharing. A device
provisioning profile is forbidden. The executable's Simulator architectures are
checked, then a bounded bundle archive and hash-bound report are retained for
three days with unchanged project licenses and the exact corresponding source
link. No signing key, account token, provisioning profile or SDK cache is uploaded.
The Android artifact also now includes the same licenses and source reference.

No Apple account is created, no agreement is accepted and no license-acceptance
command is run. Missing Xcode/license/dependency support is a blocker, not
permission to enroll or configure signing. A successful build would not imply
that a Simulator was booted or that the application ran. It does not prove iOS
rendering, Keychain behavior, browser login, lifecycle, notifications, phone
installation or store readiness. The current native login audience remains
Windows-specific. Actual mobile authentication and distribution are later gates.

Three local iOS guard groups and four Android guard groups pass. The macOS SDK
metadata is verified; actual iOS compilation and the license-bearing Android
artifact rerun remain pending CI.
