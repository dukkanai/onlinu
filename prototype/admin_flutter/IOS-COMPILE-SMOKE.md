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


iOS/Android compilation acceptance: `44431e9aca475723d2f21fdd428b390f66048f70`
passed all six requested jobs in [CI37561928593](https://github.com/dukkanai/onlinu/actions/runs/37561928593),
verified 2026-10-07 02:35 UTC: server, Windows, control image, Android, iOS and web.
Runtime-image was intentionally skipped. Xcode26.6 built a dual arm64/x86_64 iOS
Simulator bundle. Its55,116,192-byte archive hashes to
`1c5edfd40cb79ab8e9e6510e2a8affbe34efe08fdd53394e452264b7a41c1580`.
The Android89,727,246-byte debug APK hashes to
`500c8ece004b99a77a28506f03e52e0772ddc3c9a1c95f7663a4e916fcdc3367`.
Both downloads were independently source/hash/size/license checked. The iOS built
plist was independently parsed from the archive and its Simulator identity,
transport/file-sharing flags and absence of a device profile verified. Android's
arm64 Flutter engine was independently checked. Neither mobile application was
run on a device or Simulator; login, platform storage, rendering and release
acceptance remain separate. Latest full Docker-image checkpoint remains dfebcae.

## Optional owned Simulator execution — pending

The separate `ios_execute` input also selects the iOS job and asks it to create
one new, uniquely named Simulator using an already available observed iPhone
runtime/type. It never boots an existing device, selects a physical phone,
downloads a runtime, changes a global setting or uses `shutdown all`/`erase all`.
The returned UUID and unique name are checked against the runtime inventory
before use and before cleanup. An uncertain creation reply is not guessed.
Only that exact owned device is shut down/deleted, and its removal is checked.

Two actual iOS integration tests are added: isolated random synthetic Keychain
values with fresh-reader readback and key-specific removal; and Arabic RTL order
detail rendering, close and logout using the existing fake gateway. Browser
capability is queried, but no browser/login/account is opened. The screenshot is
written only in the new app's own temporary directory and retrieved from its
verified Simulator container. No other device/app storage is inspected.

The retained compile-only app archive and the integration-test executable are
distinct targets built from the same reviewed source. A successful rendering
fixture is not proof that the live account flow or every mobile screen works.
Physical-device behavior, mobile authentication, lifecycle/notifications and
release signing/distribution remain outside this check. New local guard tests
cover observed-runtime selection, exact device ownership and uncertain-create
refusal. Actual Keychain/rendering and screenshot acceptance are pending CI.


The second execution run CI37564269290 passed both actual iOS tests (Keychain
and Arabic order detail/logout) and confirmed owned Simulator cleanup. Its job
then failed while collecting the screenshot because Flutter test uninstalls the
app by default. This default and the supported `--no-uninstall` option were
verified in the exact Flutter3.47.5 SDK source. The harness now retains only its
new test app until the PNG is copied from its verified container; the entire
owned Simulator is still shut down and deleted in `finally`. The functional
checks and screenshot requirement are unchanged. A local lifecycle test covers
retention, exact app/container lookup, copied evidence and device cleanup.
Corrected aggregate acceptance and visual inspection remain pending.


iOS execution acceptance: `28b3c73237fc298eb6114b1fab55cf83b8369452`
passed all five requested jobs in [CI37566678856](https://github.com/dukkanai/onlinu/actions/runs/37566678856),
verified 2026-10-07 03:42 UTC. The new owned iPhone17 Pro Simulator on iOS26.5
passed actual Keychain isolation/readback/removal and Arabic order-detail/logout
tests, screenshot collection and verified device cleanup. The downloaded PNG
hash `1a4feada43fbf54b9580cc414009ac915c5bba439a9614ea4d1128cbf336b532`
was independently checked and the image visually inspected: Arabic detail,
amount, note and close control are readable without clipping. The55,116,203-byte
compile archive independently hashes to
`32807fa57eea2a5661e58210e4a251ee2cf7a1c59a32fbae49e1dd4c16cf7a9c`;
its source, built plist and preserved licenses were checked. This is synthetic
Simulator execution, not a physical iPhone, mobile login or store release.
Android/runtime-image reruns were intentionally skipped; their latest separate
checkpoints remain44431e9 and dfebcae respectively.
