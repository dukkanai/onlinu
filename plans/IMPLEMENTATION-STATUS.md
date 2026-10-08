# Product completion ledger

Owner-authorized direction, 2026-10-05: complete the existing restaurant SaaS
scope and decide implementation details autonomously. Work is performed directly
by the user's dot in its cloud computer, with no coding-agent delegation.
Existing production/security and external-account approval boundaries remain.

## Current local increment — 2026-10-08 09:17 UTC

- Private QR binding journal is implemented but not registered or activated.
  Fixed restaurant scope, denied-by-default change authority, persisted epochs,
  CAS replacement/removal and immutable change-request replay checks are covered.
  Restart resolution requires the same verified connection/device fingerprint.
  Final local Go race checks: all44 WhatsApp cases passed without skips; all six
  binding cases passed25 repetitions with a two-connection pool. The immediately
  preceding aggregate passed209 restaurant cases with the opt-in HTTP parity case
  run separately and passed; the added deterministic binding-lock case passed in
  the final focused run. Vet/build passed and owned PostgreSQL schemas were
  cleaned and its server stopped. CI for the binding increment is pending.
  This does not verify a real provider device, enable a number or authorize sends.

- QR session lifecycle commit `bfb305eab202c2334671a31b6b73301dfc380d87` passed all
  four ordinary jobs in [CI37754250180](https://github.com/dukkanai/onlinu/actions/runs/37754250180).
  A pre-fix regression reproduced stale open state for six provider failure
  events. They now publish the existing error state, clear obsolete login
  challenges, preserve pairing separately and retain logged-out state after a
  later disconnect. This is lifecycle correctness, not account-binding authority.

## Latest verified position — 2026-10-08 05:48 UTC

- Adjacent menu authorization windows corrected in `27ddf885f4c4da4d11e1cf92351ef4fad6b59f80`, accepted by all four ordinary jobs in [CI37733362029](https://github.com/dukkanai/onlinu/actions/runs/37733362029). Native image upload rechecks after catalogue read; browser multipart processing rechecks after body, before upload and before assignment; option edits recheck after metadata reads. A pre-fix regression reproduced the unwanted upload. Actual loopback HTTP/PostgreSQL regressions cover revocation at each named boundary and allowed happy paths, using a synthetic core. All428 local platform cases passed without skips. This does not undo an already accepted upload or establish distributed instantaneous revocation.


- Existing staff-management authority freshness fixed in `053973c93712c3a79ac5fb60aacb5002285f18cb`, accepted by all four ordinary jobs in [CI37732081482](https://github.com/dukkanai/onlinu/actions/runs/37732081482). A reproduced pre-fix regression showed that delayed request bodies could outlive a permission check. Named staff API mutations and browser channel/service/profile writes now recheck authority after body consumption. Actual loopback HTTP/PostgreSQL tests verify permission removal and tenant suspension before body completion prevent core writes; granted channel writes still succeed. All421 local platform cases passed without skips. This is bounded remediation, not a claim that every asynchronous authorization window is audited.
- Runtime WhatsApp integration now has an inspected authority/lifecycle plan in `prototype/platform/WHATSAPP-AUTHORITY-PLAN.md`. A UI paired/open snapshot is not sufficient send authority. Account binding, authenticated event hops and current operation authority remain implementation/activation gates; no live account or credential was created.


- Strict QR review-reply extraction and synthetic full boundary composition `b1041ba115e1331fca4befe3ce4508d1b1deafda` passed all four ordinary jobs in [CI37711323483](https://github.com/dukkanai/onlinu/actions/runs/37711323483). Direct fresh explicit Arabic/English commands require the replied-to provider ID and separately verified self/chat context; quoted text never supplies authoritative checkout data. The composition test covers unknown-send refusal, accepted review, explicit confirmation, original order creation and replay without another order/message. Final local PostgreSQL race evidence:38 focused cases,204 restaurant cases plus separately enabled HTTP parity, with clean fixture shutdown. Live callbacks and conversational catalogue/address collection remain unimplemented.


- Private WhatsApp review rendering and send-attempt journaling are now accepted at `88d2389909a787120e7976e9de17bb777cc3e1f7` in [CI37708807823](https://github.com/dukkanai/onlinu/actions/runs/37708807823): all four ordinary jobs passed. Full Go race and 396 platform tests passed without skips; client, Windows and control-image gates passed. A single immutable send claim, no replay after uncertainty, evidence-bound acceptance/rejection and atomic presentation are verified with synthetic transports only. The first journal CI exposed a latent dispatch lock-order deadlock; explicit head-first locks and deterministic regression tests correct it. The failed run is not counted as acceptance.
- Local disposable PostgreSQL17 now supports real database/race testing inside one live command. Final local acceptance: 34 WhatsApp cases, 200 restaurant cases plus separately enabled original-core HTTP parity, and 25 repeated concurrency/lock-order regressions. Fixture cleanup and server stop were verified. A shell session is not a durable service and must not be assumed to survive a turn boundary.
- Remaining WhatsApp integration is material: authenticated tenant/account-generation binding, current subscription/egress authority, complete conversational selections and checkout collection, live provider hook/receipt reconciliation and real-account acceptance. No current number has been linked; no shopping sender or provider account is enabled. These private components are not a finished customer-facing WhatsApp ordering flow.
- Detailed incremental records below describe acceptance at their stated commits; later bullets supersede earlier pending descriptions. Current WhatsApp design and remaining gates are in `prototype/platform/WHATSAPP-CONVERSATION-DESIGN.md`.


- Private WhatsApp review/dispatch preparation now reaches the original order core: `0d218ad8105c723b9fa06378407bfd150e4c9afc` passed all four ordinary jobs in [CI37701906784](https://github.com/dukkanai/onlinu/actions/runs/37701906784). Actual PostgreSQL/race tests verify one order/stock reservation under concurrent attempts, stable-key lost-result recovery and expiry/policy/input/owner/revocation/price/stock rejection for both channel identities. Authority remains synthetic; live account/session hooks, conversation review delivery and outgoing messages are not enabled. This is not real WhatsApp account acceptance. Previous private review-store code e5d805d passed CI37694002174.
- Private WhatsApp cart-proposal boundary `7226bb64b65fbf12a927d976495329bb0c30166d` passed all four ordinary jobs in [CI37661591551](https://github.com/dukkanai/onlinu/actions/runs/37661591551). Server-resolved scope/generation/peer binding, source freshness, bounded canonical carts, event/content hashes and original read-only pricing are tested. No transport hook, durable inbox, outgoing message or actual WhatsApp order creation is enabled. See `prototype/platform/WHATSAPP-ORDER-INTAKE.md`.
- Original React live opening status `c5ede0fadb24fb3cc082f3be5119b99ef6a91ad7` passed all four ordinary jobs in [CI37646310938](https://github.com/dukkanai/onlinu/actions/runs/37646310938). Actual Chromium covers all five templates, unknown/retry/closure, live dialog gating and Arabic RTL. The captured screenshot has not been independently visually reviewed; no production deployment.
- Structured opening-hours core `5d355255914ebfd44c47b1f84ec42651836a0fba` passed all four ordinary jobs in [CI37617238660](https://github.com/dukkanai/onlinu/actions/runs/37617238660). Full uncached Go race tests ran with disposable PostgreSQL configured, and all 383 platform tests passed without skips. Versioned Saudi weekly/date policies gate quotes/new orders while preserving durable receipt retries, stock and existing fulfillment; reviewed signed writes are atomic with audit. Browser/native transport and browser editor are a subsequent pending increment, not part of this accepted core. Flutter editor and directory filtering remain open.
- Opening-hours browser/native API and Arabic reviewed editor `3142f2427a126769b18cd050114e83ec6dbbddaa` passed all four ordinary jobs in [CI37619297901](https://github.com/dukkanai/onlinu/actions/runs/37619297901). Actual HTTP/Chromium review/cancel/save and native API/CAS checks passed; 390 platform tests passed without skips. Hosted screenshot download was blocked by the execution network policy and local Chromium could not create its sandboxed socket, so visual inspection is explicitly still open. Flutter editor and public directory filtering remain incomplete.
- Flutter opening-hours editor `ccc07c730e6f890bcf6b51388af685c1cf8c7732` passed ordinary [CI37621806474](https://github.com/dukkanai/onlinu/actions/runs/37621806474). Logs verify 155 Flutter unit/widget tests, 17 actual Windows tests including schedule review/save, actual Dart fixture-TLS through Node/original Go, uncached Go race suites and 390 platform tests without skips. Screenshot visual review is still open under the existing artifact-access restriction; no Android/iOS rerun. Public status/MCP directory integration remains incomplete.
- Bounded open-restaurant search `cdd9f28c1293a046022fa62b4c8a2a3680ad0748` passed all four ordinary jobs in [CI37626795229](https://github.com/dukkanai/onlinu/actions/runs/37626795229), with 396 platform tests/no skips and original uncached Go race acceptance. Actual MCP/core checks cover unconfigured exclusion, reviewed always-open policy/search and restoration. Explicit pages<=20, concurrency limits and unavailable/unconfigured coverage prevent guessed or exhaustive claims. Fresh read-only status previously passed a088d37/CI37624775281. Real ChatGPT account and screenshot visual acceptance remain open.
- Active development branch: `feat/saas-core-integration`; no production deployment or merge to main.
- Actual Android acceptance `28cb34e2de0c12ca0f8af69f1833e15fcf4ee775` passed all five requested jobs in [CI37612156244](https://github.com/dukkanai/onlinu/actions/runs/37612156244). The owned API35 x86_64 emulator passed real Keystore isolation, owned URL-scheme callback with synthetic token transport, Arabic rendering/logout and cleanup. Screenshot and arm64 compile artifact were independently source/hash/size/license checked; screenshot visually inspected. Specifically approved KVM access was restored and exact ACL comparison passed. No real provider login, physical device, signing or distribution acceptance. iOS remains accepted at7b141aa; full runtime-image remains dfebcae.
- Read-only Android prerequisite probe `3f3c17ef97d464af254b0e1cdf636e79563fd3f9` passed ordinary gates plus diagnostic job in [CI37602010239](https://github.com/dukkanai/onlinu/actions/runs/37602010239). Its source-bound report shows no emulator/system image installed and no current KVM read/write access, with sufficient disk space. No permission change or runtime acceptance occurred. A bounded software-emulation route is being tested separately.
- Flutter mobile callback integration `7b141aad9bffa5d601db9dbd83772a09ac4a6e52` passed all six requested jobs in [CI37599337539](https://github.com/dukkanai/onlinu/actions/runs/37599337539). 151 Flutter unit/widget tests, original Windows/server/client/control gates, Android compilation and actual iOS Simulator tests passed. The iOS native app-link roundtrip used only the owned app scheme, real secure storage and synthetic token transport; no real provider/browser-account login. Android/iOS artifacts were independently source/hash/size/license checked, iOS callback plist and cleanup verified, and Arabic screenshot visually inspected. Android execution remains open; full runtime-image was skipped and its checkpoint remains dfebcae.
- Default-off mobile broker integration `5fc868bbf936a29309a877c9ce7298d418726aa0` passed all four ordinary jobs in [CI37596296616](https://github.com/dukkanai/onlinu/actions/runs/37596296616). Server log independently confirms 383 platform tests passed with no skips, including actual PostgreSQL mobile grants and HTTP suites with mobile disabled/enabled. Cross-client/callback rejection, refresh, disabled-client bearer access, consent and revocation passed. Flutter/OS handoff remains incomplete; mobile and full runtime-image jobs were intentionally skipped. No deployed flag or external-account configuration changed.
- Native callback policy preparation `1c515984fbb8db48500ce4c1327dcc959ae0bc18` passed all four ordinary jobs in [CI37593760469](https://github.com/dukkanai/onlinu/actions/runs/37593760469). Strict Windows loopback behavior is shared unchanged; pure opt-in Android/iOS callback policy rejects client/platform swaps and noncanonical redirects. Local 269 platform tests passed, 12 database-dependent tests skipped locally; CI server supplies the disposable databases. Mobile authorization remains disabled, and no device-login or release acceptance is claimed. Mobile and full runtime-image jobs were intentionally skipped.
- Latest aggregate plus actual iOS Simulator execution: `28b3c73237fc298eb6114b1fab55cf83b8369452`, [CI37566678856](https://github.com/dukkanai/onlinu/actions/runs/37566678856), all five requested jobs successful. Synthetic Keychain isolation/removal, Arabic detail/logout, screenshot collection and owned-device cleanup passed on iPhone17 Pro/iOS26.5 Simulator. The screenshot and archive were independently hash/source checked; Arabic screenshot visually inspected. No physical-device, mobile-login or distribution acceptance. Android and full Docker checkpoints remain44431e9 and dfebcae.
- Prior aggregate plus both mobile compilations: `44431e9aca475723d2f21fdd428b390f66048f70`, [CI37561928593](https://github.com/dukkanai/onlinu/actions/runs/37561928593), all six requested jobs successful. First iOS Simulator debug bundle compiled alongside Android, Windows and ordinary gates. Both mobile artifacts were independently downloaded and source/hash/size/license checked; iOS built plist and Android ABI checked. No mobile device/Simulator execution, real login, signing account or distribution acceptance; runtime-image skipped and latest full Docker-image remains dfebcae.
- Prior aggregate plus Android compilation: `c7ca1bc9c1ba39315f8af0f78a1911e8ca2df7c2`, [CI37558220905](https://github.com/dukkanai/onlinu/actions/runs/37558220905), all five requested jobs successful. First generated Android arm64 debug APK compiled with the reviewed lockfile, passed decoded manifest checks, and was independently downloaded/hashed/ABI-checked against its source-bound report. This is a control.invalid compile-only artifact, not phone/login/storage/notification/release acceptance. Runtime-image skipped; latest full Docker-image remains dfebcae.
- Prior ordinary acceptance: `fba4361a8abf59303bd99875ba4ad7acc8b1eb70`, [CI37556938885](https://github.com/dukkanai/onlinu/actions/runs/37556938885), all four ordinary jobs successful. The private composed host driver passed coordinator/compiler/stager/manifest assembly tests with synthetic external capabilities and a mock journal. Single-attempt fencing, phase guards, original bootstrap resolution and uncertainty were checked. No server wiring, production apply, real credential provisioning or activation; runtime-image intentionally skipped and full-image remains dfebcae.
- Prior ordinary acceptance: `76e3419e6d38871bee407da71f54d638dbc1b3b9`, [CI37555755861](https://github.com/dukkanai/onlinu/actions/runs/37555755861), all four ordinary jobs successful. Existing pinned-image preflight passed real compiler plus simulated Docker transport tests and aggregate regressions. Actual registry provenance/publication is not claimed; runtime-image was intentionally skipped and latest full-image remains dfebcae.
- Latest aggregate/full-image acceptance: `dfebcaebea60489d63c2efe4057ccd4165f15265`, [CI37554750785](https://github.com/dukkanai/onlinu/actions/runs/37554750785), all five jobs successful. The shared bounded direct-loopback health and authentication transport passed both actual successful and unknown-reply reconciliation fixtures, including missing/wrong-key rejection. Four reports and both immutable receipt hashes/bindings were independently verified. Production key loading and deployment remain outside the synthetic acceptance.
- Prior aggregate/full-image acceptance: `7685020ebc885d2dac99f15fc5384abe79fbd32c`, [CI37553654551](https://github.com/dukkanai/onlinu/actions/runs/37553654551), all five jobs successful. Original-manifest and existing-secret metadata checks passed regression. The disposable PostgreSQL backup restored into a fresh database with all43 public tables and6 sequences matching; source preservation and neighbor uptime passed. Four reports and two receipt hashes/bindings were independently inspected. This does not accept production secrets, session/media backup, off-host recovery or deployment.
- Prior ordinary acceptance: `43c94a81b55a258cc96bf195c0433056ecea8116`, [CI37550903838](https://github.com/dukkanai/onlinu/actions/runs/37550903838), all four ordinary jobs successful. Optional operator-only read API and Arabic queue page passed actual PostgreSQL/HTTP/Chromium checks; screenshot inspected. Current admin/browser authority, bounded microsecond-safe pagination and non-mutating expired/unknown views are verified. Default remains disabled; no execute/activate/cancel route was exposed.
- Prior full-image acceptance: `813e69264da0997021bd6a8532afd22bbdbc50a9`, [CI37548290444](https://github.com/dukkanai/onlinu/actions/runs/37548290444), all five jobs successful on public standard runners. Stable before/authentication/after runtime verification now precedes exact durable evidence in actual successful and unknown-reply reconciliation fixtures. Four reports and both receipt hashes/bindings were checked. Production credentials, routing, activation and release remain separate.
- Prior aggregate/full-image acceptance: `5d973314e5f8c794328a96ccd7f89249c3723ce9`, [CI37545039166](https://github.com/dukkanai/onlinu/actions/runs/37545039166), all five jobs successful. The single-attempt Compose transport and shared empty-namespace preflight passed actual isolated creation and reconciliation. Four reports and two immutable receipt hashes/bindings were inspected. No production execution or credential setup occurred.
- CI visibility decision: after the owner explicitly authorized public conversion if no secrets were found, all reachable history and surfaced candidates were reviewed. The repository became public on 2026-10-06 23:38 UTC, verified by an unauthenticated API read. Standard GitHub-hosted checks may resume under the public-repository free-usage policy. The earlier quota hold ran from23:17 to23:38; no new workflow was dispatched during it. No budget, paid runner or persistent self-hosted access was configured. Continue local checks and batch heavy acceptance; do not claim deferred checks passed.
- Prior aggregate/full-image acceptance: `58b00c01abb72e56d2157764b4a0991df52ef878`, [CI37543411440](https://github.com/dukkanai/onlinu/actions/runs/37543411440), all five jobs successful. Original staged artifact handles and exact manifest/bootstrap/receipt bytes are revalidated under live actor/worker fencing before use. Actual fixture execution and reconciliation passed; four reports and two receipt hashes/bindings were inspected. Production apply and real secret provisioning remain separate gates.
- Prior aggregate/full-image acceptance: `d099829ea7030a2a45b75d83e1c55bbc467e55c3`, [CI37542056436](https://github.com/dukkanai/onlinu/actions/runs/37542056436), all five jobs successful. A shared bounded read-only Docker probe now obtains the exact owned snapshot for both successful and unknown-reply reconciliation paths. Fixed commands, local context, bounded/redacted responses, cancellation and caller-state isolation have tests; actual daemon acceptance passed. Four reports and both receipt hashes/bindings were checked. Production apply, credential provision, public routing and release gates remain separate.
- Prior aggregate/full-image acceptance: `9154929f905fab1b2024313c64ae0f5738686651`, [CI37540564750](https://github.com/dukkanai/onlinu/actions/runs/37540564750), all five jobs successful. Complete owned runtime snapshots now gate verification in both successful provisioning and unknown-reply reconciliation fixtures. Container/image identity, mounts, private ingress, network ownership/membership and local-volume checks passed actual Docker acceptance. All four reports were inspected and both immutable receipts independently rehashed. This remains isolated fixture evidence, not a production executor or deployment.
- Native payment-method milestone: `e1249c76dcea4e49e26529e4d18a4860b226f8cf`, [CI37503661616](https://github.com/dukkanai/onlinu/actions/runs/37503661616), all four ordinary jobs successful. Configured payment-method management is accepted across original Go/Node API, browser and Flutter. Current-tenant/read-and-write grants, stale catalogue versions, explicit review, unchanged historical orders and uncertain-response handling are covered; actual Dart TLS mutations and Windows forms/build passed. Browser and Windows review/saved screenshots were visually inspected. Provider connection, real charging and mobile-device acceptance remain separate. See `prototype/platform/PAYMENT-METHOD-MANAGEMENT.md`.
- Prior full runtime-image CI acceptance: `f9a965f035efea575836c4f8cff2f6bf01ce094f`, [CI37479843024](https://github.com/dukkanai/onlinu/actions/runs/37479843024), all five jobs successful. Delivery origin/radius management remains accepted across Go/Node/browser/Flutter; the original codec-bearing runtime and all isolated runtime/journal fixtures were rerun for this exact commit.
- Four exact-commit runtime reports were downloaded and inspected: original runtime startup, two-tenant isolation/recreation, client cancellation versus daemon state, and journal/Docker lifecycle. Both new immutable verification receipts were independently rehashed and bound to their job/worker/tenant/plan. These remain synthetic acceptance, not the production apply driver, registry publication or deployment.
- Integrated: original core pricing/stock/order/payment/event logic; persistent subject identity and memberships; owned MCP/browser checkout; staff orders/cash/channels/stock/basic menu; reviewed quote binding and owned financial summary.
- Native category/options/image editing, strict Dart TLS/PKCE integration, rotating refresh and actual Windows forms/store/build passed remote CI (73 Flutter unit/widget tests in the published image commit). Image-review and create-item screenshots were inspected; Arabic layout and corrected form spacing are readable. OS picker selection remains a synthetic injection in rendering tests.
- Native team roles, granular permissions, alias/enable edits and explicit review/confirmation passed all remote CI jobs: 78 Flutter tests, 196 platform tests and real Dart/Node/Go membership read/update/stale/last-owner checks. Native membership authority cannot inherit separate platform-operator privileges. Windows team screenshots were inspected.
- Six-field public business profile passed all remote CI jobs (81 Flutter/197 platform tests, Go audit/preservation, actual Chromium and Windows forms); screenshot inspected. This is not broad settings parity.
- Original delivery pricing/geographic district coverage passed all remote CI jobs: 86 Flutter/198 platform tests, actual Dart TLS and Go historical-fee/audit/omitted-field checks, Chromium and Windows forms. Browser selectors gained explicit accessible names. Long functional client suites use distinct loopback peers without relaxing production limits; shared-NAT/load fairness remains a release gate. Per-kilometre pricing and service/location editing remain outside this increment.
- Reviewed dispatcher assignment to existing original-core couriers passed all CI jobs: 91 Flutter/199 platform tests, actual Dart/Go assignment/unassignment, Chromium and Windows review forms, audit rollback and reassignment isolation. Windows review screenshot inspected.
- Courier identities/owned work in `77a688f` plus packaging fix `faa7c44` passed all remote CI jobs. Separate cash/update grants, selected contact/address detail, own availability, explicit versioned bindings and queued-revocation/audit checks are covered. Windows review screenshots inspected; no real accounts or GPS were enabled.
- Service-intake `1a7fdc7` plus translation correction `408cc73` passed all CI37364343927 jobs after hosted-runner recovery. Prior cancelled jobs never ran their tests; they were not code failures. The official GitHub Actions incident is recorded at https://www.githubstatus.com/incidents/3q1yb5m7ltvb .
- Read-only staff payment/refund snapshots (`2928ec6`) and courier revocation hardening (`35eb297`) passed all CI37379196274 jobs: 108 Flutter/210 platform tests, actual Dart/Node/Go/Chromium paths, original refund regressions, Windows native forms/store/build and React checks. Financial and identity-picker screenshots were inspected. No real account or money operation was performed.
- Suspended tenants may revoke existing courier bindings but cannot grant new ones. The native searchable single-choice identity list masks private content when permission changes; it does not leave a private dropdown overlay visible. Closed tenants remain inaccessible.
- Existing-refund backend `3662cae` passed all CI37383212394 jobs (213 platform tests, actual Node/Go commands, original refund regressions, unchanged native108/React 80 suites). No real payout occurred.
- Refund review UI `89e650d` passed all CI37384391681 jobs, including Chromium review/cancel and Windows renderer/build; Flutter115/platform214. RTL rendering correction `27e8096` passed all CI37385242822 jobs; the refund-review screenshot was inspected and is readable without clipping.
- Existing-refund manager detail and reviewed authorize/manual/verify/refresh backend commands reuse the original durable ledger, with transactional actor audit, current three-grant authorization and no POST retry. See `prototype/platform/REFUND-MANAGEMENT.md`. Local/remote validation of this new increment is separate from the verified commit above. Browser/Flutter confirmation forms now pass local115 Flutter tests, platform214 and actual Dart TLS/Node/Go authorization and same-ID recovery. Actual Chromium/Windows checks passed for89e650d; the RTL screenshot check also passed and was inspected. No new refund-creation route is added.
- Native Windows PKCE client, order/cash UI, actual OS-store/rendering smoke and unsigned build are verified at the published commit above. The synthetic screenshot was inspected; no Arabic clipping observed.
- Next management increment: original appearance drafts and explicit publication/restore. Local backend tests reuse the five templates and inherited-font rules, preserving unrelated menu/tax/orders and rolling back on actor-audit failure. See `prototype/platform/BRAND-MANAGEMENT.md`; browser/native appearance forms now pass local121 Flutter/217 platform tests and actual Dart/Node/Go draft/publication/restore; all CI37387124412 jobs passed, including Chromium and Windows renderer/build. The Arabic draft-review screenshot was inspected and is readable without clipping. Color/media editing and visual customer-template preview remain in the original editor.
- Next support-management backend: bounded pending cancellation/complaint queue, private selected detail and original reviewed decisions. A distinct `support:manage` grant is not automatically added to existing memberships. Local original PostgreSQL/race, actual Node/Go, platform 220, unchanged Flutter 121 and React 80/build checks pass; the browser/native support UI now passes local 130 Flutter/222 platform checks, actual Dart/Node/Go and related original race regressions. Combined CI37392724013 passed all jobs, including actual Chromium checked complaint resolution, Windows review/decision rendering and unsigned build, full server/client and control-image checks. The Arabic support-decision review screenshot was inspected: the checked confirmation, tenant/order/version, amount and no-money-dispatch warning are readable. Paid-card cancellation correctly remains payment `review`, not confirmed refunded. See `prototype/platform/SUPPORT-MANAGEMENT.md`.
- Customer-owned cancellation/complaint handoff is implemented locally: confirmed browser checkout, reviewed reason, original signed ownership and hash-only durable dispatch claims. Local 226 platform tests, original Go race regressions, actual Node/Go/central HTTP, React 80/build and vet pass. All CI37394646960 jobs passed, including actual Chromium reviewed cancellation and Windows regression/build. The Arabic browser review screenshot was inspected and is readable; see `prototype/platform/CUSTOMER-SUPPORT.md`. Unresolved outcomes block new keys and do not automatically replay writes.
- Follow-on customer recovery: an explicitly reviewed same-ID retry now addresses never-arrived support requests without automatic replay or a new logical request. Original tuple/hash and ledger recovery are checked; legacy missing-version rows remain blocked. Local 226 platform and original Node/Go/HTTP tests pass; all CI37396101646 jobs passed, including actual Chromium retry and unchanged Windows regression/build. The customer Arabic-label/focus correction plus legacy browser assertion update passed all CI37397669126 jobs. The retry-review screenshot was inspected: translated states and navigation are readable without the transient validation bubble.
- Original tax settings bridge is implemented locally with browser/native review, separate signed scopes, exact basis points, historical-price preservation and transactional audit. Original PostgreSQL/Node/Go and actual Dart TLS checks pass; local 136 Flutter/230 platform/React 80 checks, analyzer, vet and builds pass; all CI37398729778 jobs passed, including new Chromium and Windows review/build. The Arabic Windows tax-review screenshot was inspected and is readable without clipping. See `prototype/platform/TAX-MANAGEMENT.md`.
- Isolated-runtime preparation: opt-in file-backed Go secrets and private startup diagnostics pass local race/subprocess and related original auth/Meta/archive/translation/HTTP integration checks. Raw file values are not exported into child environments. All CI37401147861 jobs passed for the file-backed secret increment. The administrator startup guard and isolated actual-main smoke also passed all CI37405031722 jobs; this includes actual startup, administrator authentication, signed service reads and the unchanged native Windows regression/build. Existing installer configuration is untouched; provisioning and runtime-image acceptance remain open. See `deploy/RUNTIME-SECRETS.md`.
- Actual-main restricted-role extension `2c4fb7f` passed all CI37406247021 jobs: runtime startup uses a temporary non-superuser CREATEDB role, with flags and owned database checked. No production role change or cross-tenant isolation acceptance occurred.
- Offline resource planner `ef87ab9` passed all CI37407109723 jobs. Eight pure planner tests and all 45 local deployment/packaging tests pass. It emits non-executable, digest-identified requirements with distinct tenant resources and no Docker, network or secret operations. A provisioning executor is still absent; see `deploy/TENANT-PLAN.md`.
- Original WhatsApp session-storage migrations under the restricted fixture role passed all CI37408369717 jobs for `1604e9e`; no WhatsApp client or external session was created.
- Opt-in image acceptance preparation `d25f00a` passed ordinary CI37409249616, including all 49 deployment/packaging tests and fake-Docker cleanup guards. Full root-image build is deliberately disabled by default; external codec execution approval and image acceptance were pending at that stage and were subsequently accepted as recorded below. See `deploy/RUNTIME-IMAGE-ACCEPTANCE.md`.
- Approved full-image acceptance: first CI37421243686 built the image but its host-port probe failed; no acceptance was claimed. Revised internal-only probe `0877142` passed all CI37422274567 jobs, including UID 10001, read-only root, private file mounts, health/admin authentication, restricted database ownership and no published test ports. The non-secret report was downloaded and checked. This proves the tested image startup, not real calls, registry publication, production routing or multi-tenant isolation.
- Reviewed-plan Compose rendering and PostgreSQL 16 file-backed role bootstrap `264157d` passed all five CI37424797423 jobs. This includes 57 deployment/packaging tests, Docker Compose schema validation without deployment, and the original image running after the mounted SQL asset bootstrapped a restricted role. The report was downloaded and checked. No provisioning executor, public apply endpoint, tenant registration, real secrets or production deployment was added.
- Private operator provisioning journal `33f15a4` passed all ordinary CI37427159676 jobs (243 platform tests without skips). Idempotent initial intent, fenced worker/version leases, uncertainty, evidence-required reconciliation and transactional audit do not execute Docker, activate a tenant or expose a public endpoint.
- Two-rendered-tenant acceptance `1b938f5` passed all five CI37429655725 jobs. The downloaded report confirms distinct databases/media/keys, actual container hardening and loopback bindings, cross-key rejection, cross-network TCP denial, and container recreation with retained markers and unchanged neighbor start times. Only fixture image references and host-file paths override the renderer. This is isolated CI evidence, not production execution, registry publication, capacity or backup/restore acceptance.
- Private reviewed-artifact bridge `de31ccd` passed ordinary CI37434333447, with 255 local platform tests and actual-main Go race checks. Strict bounded file reads and isolated authoritative Python compilation bind job/tenant/digest, approved images/issuer/key and bootstrap bytes. Authority and worker lease are checked before and after preparation; no secret values or Docker execution are accessed.
- Single-attempt coordinator `040ecb5` passed ordinary CI37436422280, with 269 local platform tests. Claim, inspect/apply/verify checkpoints and strict evidence are sequenced under an injected host lock; ambiguous database/driver replies require reconciliation without automatic retry or activation. The apply/verify implementation remains a synthetic fixture, not a production driver.
- Concrete Linux host exclusion `e7b6d58` passed ordinary CI37438055020, with 275 local platform tests without skips and actual-main Go race checks. Real separate-process flock tests prove same-tenant contention, independent neighboring locks, callback/worker-exit release and stable lock inodes; the PostgreSQL/compiler/coordinator test now uses this real lock. A released lock does not prove a Docker daemon action stopped. See `prototype/platform/PROVISIONING-HOST-LOCK.md` and `PROVISIONING-RUNNER.md` for cancellation, ownership, secret and recovery gates still required.
- Private bounded-process transport `28709b0` passed ordinary CI37440216640, with 282 local platform tests without skips and related Go race checks. No-shell/minimal-environment execution, sanitized failures, bounded output, abort/timeout owned-process-group termination and host-lock retention have real synthetic process tests. This is not proof that a Docker daemon operation was cancelled and does not supply the production apply/verify driver. See `prototype/platform/PROVISIONING-PROCESS.md`.
- Exclusive artifact staging `518c637` passed ordinary CI37444321105, with 286 local platform tests without skips and related actual-main Go race checks. Only authoritative in-process artifacts for the current claimed worker can produce private, exclusive per-attempt manifests/receipts and public bootstrap SQL. Files are synchronized and retained on later authority failure; no secret values or Docker execution are involved.
- Real Docker cancellation acceptance `7dbde99` passed all five CI37446321930 jobs. The downloaded report proves a single owned, never-started, mount-free/port-free container survives command-group cancellation, with host exclusion, no creation retry and exact ownership-verified cleanup. This supports conservative uncertainty handling; it does not prove that killing a Docker client cancels daemon work, nor does it establish full journal/Docker execution. The original image and two-tenant tests also passed again.
- Integrated journal/Docker acceptance `147a8c1` passed all five CI37451506853 jobs after correcting a noncanonical synthetic issuer in the first fixture run. Actual PostgreSQL identity/journal, compiler/preflight, exclusive staging, Linux host lock and bounded commands reached two disposable tenants: one successful attempt, one lost apply reply retained as unknown with replay blocked, then actual inspection and explicit evidence reconciliation under the host lock. Each applied once; tenants stayed draft; exact Docker/schema cleanup passed. Explicit image/path/identity fixture overrides and production credential/registry/routing/recovery gates remain.
- Delivery origin/radius management now uses the original catalogue CAS/audit and coverage calculation. Signed updates preserve omitted origin, support explicit clearing and reject incomplete coordinates or invalid radius. Browser/native writes recheck revoked permissions after body parsing. Chromium and native Dart TLS tests cover save, stale/invalid requests and restore; Windows editor/review screenshots were inspected. Radius is straight-line coverage, not road distance or per-kilometre pricing. Old-core responses do not expose unsupported editors. The first native run stopped only at formatting; the declared Dart 3.5 formatter correction passed all ordinary gates in `4188128`.
- Private immutable provisioning evidence `f9a965f` passed all five CI jobs. Receipts are bounded, strict, non-secret, exclusively persisted and read back with hash/binding checks; both actual Docker fixtures embed their read-back evidence in the retained report. This preserves verification evidence without granting operator authority or proving future resource health. See `prototype/platform/PROVISIONING-EVIDENCE.md`.
- POS integration is explicitly deferred by the owner’s voice instruction; continue current development without choosing/connecting a vendor.
- Still incomplete: broader management and Flutter parity,  WhatsApp ordering, isolated tenant provisioning and subscription billing, actual external-account acceptance, deployment/rollback rehearsal and release approval.
- Historical verification entries below describe their exact commits; they are not a claim that the entire SaaS is complete.

## Acceptance order

1. Repeatable isolated database tests, CI coverage and baseline fixes.
2. Connect the existing restaurant core to the platform/MCP without duplicating
   money, stock, delivery, tax or order state rules.
3. Owned checkout and order status, durable event integration and identity binding.
4. Restaurant registry/lifecycle, staff identity/roles, channel entitlements and
   isolation across API, database, files, jobs and events.
5. Complete Flutter management parity while retaining React management and all
   five customer templates. Windows validation precedes mobile distribution.
6. Provider-specific payment/refund and WhatsApp order integration; external
   account acceptance must be recorded separately from simulated test results.
7. Production readiness, transfer/rollback and release acceptance. No production
   deployment is implied by local progress or a pushed feature branch.

## Completed baseline

- Full authenticated Git checkout and private branch pushes verified.
- Exact pinned Saudi geography data restored with license/provenance and
  narrow packaging allowlists; focused test and 37 Python tests pass.
- Nine pre-existing Go formatting errors corrected (57d6677).
- Local PostgreSQL 17 installed in the cloud workspace, loopback-only synthetic
  cluster. First DB-enabled run: Go 549 passed/5 network-limited failures/1 native
  codec skip; tenant 8 passed; platform 108 passed without skips. Counts include
  nested tests and must not be presented as independent feature coverage.
- CI definition now prepares PostgreSQL 16, exercises DB cases and client tests.
  Local PostgreSQL 17 success is not proof of CI's PostgreSQL 16 outcome.

## First core integration milestone

Original core adapter, contact-free cart preview and read-only core MCP mode
are pushed in e8af8cc. Cross-language parity uses real Go HTTP/PostgreSQL and
SDK MCP for two restaurants, five templates and three modes. CI coverage update
ae47673 passed GitHub Actions run 37277857214, server and client, including the
WebRTC tests blocked locally. Local DB-enabled baseline is 568 Go passes,
five environment-specific media failures and one native codec skip; platform
115 passes, tenant eight, client 80 and Python 37. Counts include subtests.

Subject-based identity, granular tenant memberships and control-plane HTTP are
the next increment. They reuse verified OIDC and OAuth/PKCE while excluding
fixture identities in persistent mode. See `prototype/platform/IDENTITY-CONTROL.md`.
Identity increment a1f6647 passed CI run 37279746306 with 134 platform tests.
Owned original-core checkout and signed requests are pushed in 996fa81 and passed
CI run 37282467824. See `prototype/platform/CORE-ORDERS.md`.

The current increment adds owned provider redirects, independently verified
payment refresh, transactional original-core outbox and durable central Events
delivery, plus the explicit control-plane runtime/image. Local full regression:
583 Go passes, the same five sandbox netlink/media failures and one native codec
skip; tenant eight, platform 149, client 80, Python 37. Go vet/build and client
type-check/build pass. Counts include subtests. Cross-language tests use real
Go HTTP/PostgreSQL/MCP with simulated provider/callback transports, not live
merchant or ChatGPT acceptance. CI now separately builds and checks the non-root
control image. See the subsequent publication and browser outcome below.
See `prototype/platform/CORE-PAYMENTS-EVENTS.md` for scope and limitations.
Payment/Events commit 76d2828 passed CI 37286386290, including the control image.
The subsequent Chromium navigation regression in ed5f59a failed CI 37286898595
at the provider redirect; diagnosis remains active. HTTP success is not browser
acceptance. The initial staff order bridge and `/manage` view are being added
with separate membership/CSRF/scopes and transactional audit; see `CORE-STAFF.md`
in `prototype/platform/`. Full management and Flutter parity remain open.
Staff increment local checks retain 583 Go passes/five known local restrictions/
one codec skip, with 150 platform tests passing, including staff page escaping.
Browser diagnostics were expanded and CI now runs the focused browser test
before the full suite, so a failure cannot be hidden among unrelated checks.
CI 37288011980 identified the HTML form's `Origin: null`/referrer-policy conflict.
The correction preserves strict Origin/CSRF checks while using `same-origin`
referrer policy only on HTML. Local focused Go and all 150 platform tests pass;
Chromium acceptance must still be confirmed on the new remote run.

Commit 2b24ccd passed all CI jobs in run 37289872901, including actual Chromium
payment redirect/Back, staff navigation, OAuth consent/registered callback/PKCE,
full server race tests and the non-root control image. The browser transport is
now explicitly isolated with CDP redirect interception and a dead loopback proxy;
no real account/payment acceptance is implied.

Current uncommitted increment: original-core atomic channel-ordering policy,
staff/native management and browser forms, plus expired-unresolved-checkout
recovery protection. See `prototype/platform/CORE-CHANNELS.md`. Full regression
and publication of this increment remain pending.
Its local full regression has 585 Go passes/five known network restrictions/one
codec skip and 152 platform passes, with the final additional HTTP policy test
covered by a subsequent focused race run. Vet/build and 37 packaging tests pass.

Channel-policy commit 958d518 passed all CI jobs in run 37292236715, including
browser disable/enable forms, full race tests and translated customer errors.
The browser assertion correctly waits for hidden version fields to be attached,
not visible. Client tests scan backend error codes: rerun them when Go errors
change even if no TypeScript implementation changed.

Current increment adds kitchen-facing order detail without structured contact or
receipt capabilities. Focused real Go/PostgreSQL/Node HTTP tests, all 154 platform
tests, Go vet/build and client 80 tests/type-check/build pass locally. Browser
detail navigation is added to CI and remains pending publication/remote evidence.

Kitchen detail commit 4000bfc was pushed and passed all CI jobs in run 37293304675,
including real Chromium detail navigation. Current uncommitted work adds the
original-stock read/recount bridge and staff form with attributed transactional
audit; see `prototype/platform/CORE-STOCK.md`. It preserves active holds and
does not invent historical actor attribution. Regression/publication are pending.
Stock local regression: 588 Go passes, the same five local netlink restrictions
and one native codec skip; 155 platform, eight tenant, 80 client and 37 packaging
tests pass. Go vet/build and client type-check/build pass. Chromium stock recount
is included in the next remote CI run rather than claimed from local HTTP tests.

Stock commit 49a0159 passed all CI jobs in run 37295426884, including the Chromium
recount form and preserved active holds. Current menu item-edit increment has
589 local Go passes/five known netlink restrictions/one codec skip, 157 platform,
eight tenant, 80 client and 37 packaging tests passing. Focused Go/PostgreSQL
proof covers private settings/table preservation, immutable historical order
prices, optimistic conflicts and transactional audit failure. Remote browser
menu editing remains to be validated after publication. See `CORE-MENU.md`.

Near-term gaps remain explicit: owned customer receipt/detail and option/tax
review, full menu CRUD/media and brand/settings/delivery/refund parity, native
staff authentication/Flutter, real WhatsApp order ingress and controlled tenant
provisioning. Successful increments do not close these release gates.

## External acceptance still required

- Actual ChatGPT account/Extensions/Events flows on an approved HTTPS origin.
- Merchant sandbox/provider agreements/credentials when integrating payments.
- Windows environment and signing/distribution credentials at packaging time.
- Production server access and explicit rollout confirmation. Existing product
  plans report historical staging at almujeeb.info; current live state has not
  been reverified or changed by this cloud-development work.
- Security/licensing and geographic-data gates in SAAS-LAUNCH-GATES.ar.md remain
  distinct from a successful source-data restoration.

### Customer review and immutable financial summary (verified, 2026-10-05)

- Menu increment e501fd2 verified: CI 37299568106 succeeded in server, client and control-image, including actual Chromium browser flow.
- Added option/subtotal/delivery/inclusive-tax review and owned original-order financial detail. Minimal MCP/event DTOs remain unchanged; contacts and receipt capabilities remain excluded.
- Added optional backward-compatible core quote binding. Central confirmations always bind the reviewed snapshot; Go rechecks inside Create transaction to reject same-total detail/tax changes. Accepted idempotent recovery remains first.
- Added cross-language golden vectors, changed-tax regression, owner-isolation/detail tests and escaped-summary tests. Local verification: 591 Go passes, five known sandbox netlink failures and one codec skip; 162 platform, eight tenant, 80 client and 37 deployment tests pass. Go vet/build and client TypeScript/build pass. Final focused Go ownership/quote/real Node-control integration rerun passes. Published as 96684ba; CI37302577893 passed all server, client and control-image jobs, including actual Chromium checkout/staff/OAuth regression.
- Full project remains open: menu/category creation and options/media UI, remaining management/Flutter parity, WhatsApp ordering, provisioning/billing, external provider/OIDC/ChatGPT acceptance and production gates are not complete.

### Scoped category/item creation (verified, 2026-10-05)

- Added narrow versioned original-core category/item creation, same-transaction actor audit and catalog validation. No entire-settings write or historical-order mutation is exposed.
- Added staff-only APIs and browser forms with stable generated IDs and CSRF. Browser-created items begin disabled for explicit review/activation; kitchen/customer OAuth cannot create them.
- Added atomic-audit/duplicate/stale/unchanged-settings tests and actual control-plane/browser creation coverage. Local aggregate: 592 Go passes, five known sandbox netlink failures and one codec skip; 164 platform, eight tenant, 80 client and 37 deployment tests pass. Go vet/build and client type-check/build pass. Published as f66c9d4; all CI37303346507 jobs passed, including actual Chromium category/item creation.

### Option/category editing (verified after browser correction, 2026-10-05)

- Added category rename/reorder with original-core version validation and atomic actor audit, preserving item assignments and settings.
- Added staff-only option add/edit/disable forms; narrow current-item merge and final core version check prevent stale overwrites. Stable IDs, maximum 50 options, exact price parsing and historical receipts remain intact.
- Added full control-plane permission/CSRF/stale/price-snapshot checks and real Chromium option/category editing cases. Local: 593 Go passes, five known sandbox netlink failures, one codec skip; 165 platform, eight tenant, 80 client and 37 deployment tests pass, with vet/build/type-check success. Remote browser regression pending.

### Checkout error HTTP status correction (2026-10-05)

Inspection found that the friendly checkout error renderer wrote HTTP200 before
attempting to assign the intended error status. It now supplies the status when
writing headers. An actual Go/control-plane integration assertion checks expired
HTML confirmation returns409 and its Arabic explanation, while JSON behavior is
unchanged. Focused real-core regression passes locally; remote verification is
pending. This does not alter order submission or payment state.

CI37304245517 on 6ae0e8a failed at Chromium option availability selection: the
exact label lookup included the select's option text. The option control now has
an explicit accessible name matching its visible label. Server-side integration
and unit cases passed; this browser correction requires a new complete CI run.

CI37304792692 on db9ae2b passed all server, client and control-image jobs,
including corrected Chromium option/category flows and HTML error status test.

### Original-core menu media (verified, 2026-10-05)

- Staff-only bounded multipart upload → raw-byte signed core upload → existing Go image normalizer → versioned/audited item image assignment.
- Fixed-origin, content-hash-checked public media delivery and absolute own-origin MCP menu/brand image URLs; no arbitrary URL fetch or credential forwarding.
- Local multipart/Go normalization/permission/CSRF/stale/ownership tests and Chrome preview cases added. Native browser-selected-file submission has a separate loopback-only synthetic ingress test because CDP omits binary file parts; this is not a replacement for separately tested HTTPS identity/origin checks. Remote execution is pending.
- Local aggregate: 594 Go passes, five known sandbox netlink failures and one codec skip; 170 platform, eight tenant, 80 client and 37 deployment tests pass. Vet/build/type-check pass. New remote browser/runtime verification pending. No production image, credential or storage configuration changed.

Media3183508 passed all CI37306155756 jobs, including native Chromium file
selection/multipart upload through the loopback-only test ingress and image
preview. Existing HTTPS browser identity/origin tests also passed.

### Staff membership UI (verified, 2026-10-05)

- Added verified-account-ID onboarding, display aliases, role presets/custom permissions, enable/disable forms and friendly browser errors over existing directory authority/version/last-owner protections. No email linking or invitations.
- Added backward-compatible central columns for aliases and before/after permission audit snapshots, committed with membership changes. Historical rows remain empty rather than fabricated; audit does not copy alias text.
- Local final platform suite172/172 and focused actual Go/control-plane integration pass after correcting bearer HTML access to refuse before login redirect. Baseline Go594 passes/5known localnetlink failures/1codec skip, tenant8/client80/deployment37 and builds remain passing at their tested boundaries. New remote membership browser flow pending.

Staff membership caf7d5d passed all CI37307753202 jobs, including Chromium
creation/enable/granular-read/disable and last-owner guard. Native work is next.

### Native authorization broker foundation (in progress, 2026-10-05)

- Selected system-browser PKCE for Windows, consistent with the existing plan and RFC8252; device-code flow was evaluated but not selected for browser-capable native clients.
- Shared broker gains a fixed native public-client profile with a separate issuer/resource/scope, bounded loopback redirects,15minute access/8hour refresh family, customer/native revocation isolation and own-device grant management primitives. No HTTP native routes are exposed yet.
- Final local platform179/179 and focused real Go/control-plane regression pass. Native UI/HTTP/API/Flutter wiring and remote regression pending.
- Pinned official Flutter3.47.5 SDK checksum/version verified outside Git. Its cloud autodetection was blocked; source inspection identified the official CI/BOT short-circuit, which avoids the metadata request entirely. Workspace-local config and disabled analytics work. Flutter dependency/baseline tests are still running.

Native broker foundation6d97f7c passed all CI37310443981 jobs. Flutter3.47.5
baseline dependency resolution, analyze and12 tests passed with explicit
per-command `--suppress-analytics` and CI/BOT configuration. No cloud metadata
was used and no telemetry permission was granted.

### Native HTTP/API wiring (in progress, 2026-10-05)

- Added default-off native runtime flag, browser consent and cancellation, canonical metadata, native token/revoke endpoints and own-device browser revocation.
- Browser and native staff transports share one existing permission-checked operation router. Native access additionally requires membership in the requested restaurant and cannot inherit platform-operator bypasses or call registry lifecycle APIs.
- Added PostgreSQL HTTP consent/isolation/revocation tests and actual Go/control-plane native order reads/menu write, plus new Chromium loopback-callback/device-revoke cases. Local platform184/184 and Go regression pass except the five known local netlink cases; remote new browser cases pending.
- Release follow-up: fix trusted-proxy/per-principal rate limiting and load-test before scale claims. MFA policy/OS secure-storage acceptance, Windows signing, Flutter parity and mobile callbacks remain open.

### Native Flutter core client — 2026-10-05 (verification in progress)

Backend `24becfc44e42081be001c1da1fe9849ac934c54c` passed all jobs in
CI `37313695046`, including Chromium native PKCE consent/callback and own-device
revocation. Flutter now has separate `CORE_API_BASE_URL` mode: external-browser
PKCE, origin-bound OS-secured refresh, transient access token, multi-restaurant
selection, last100 orders/detail, optimistic status/cash operations and explicit
confirmation. Synthetic mode remains loopback-only and unchanged.

Local Flutter analyze and all38 tests pass, including final membership-removal
and stale-snapshot regressions. No real customer/provider
credentials are used. Secure-storage unit tests use plugin mocks and do not prove
Windows OS storage acceptance. New Windows CI job verifies official SDK SHA256,
locked dependencies, analysis/tests and unsigned `.invalid`-origin smoke build;
its first run is pending. Native app parity, signing, MFA, device acceptance,
production and scale gates remain open. See `prototype/admin_flutter/README.md`.

### Explicit trusted-proxy request budgets — 2026-10-05

The earlier reverse-proxy finding is addressed in code with opt-in
`CORE_TRUSTED_PROXY_CIDRS`, never implicit header trust. Right-to-left trusted-hop
selection, bounded/canonical addresses, independent client budgets and Retry-After
are covered by unit and real HTTP tests. Local platform/PostgreSQL suite190/190
and actual Go↔Node race integration pass. Docker runtime includes the new module.
No live proxy/network configuration has changed. NAT sharing, per-process limits,
per-principal fairness, SSE/polling and distributed load acceptance remain open;
see `prototype/platform/REQUEST-LIMITS.md`. Remote CI for this increment pending.


Native Flutter commit `7c57929de5e14195f729f07764110bfdb5c717c1` passed all
four CI jobs in run `37318712862`, including Windows analysis/all38 tests and
successful unsigned release compilation with locked plugins. The retained
`.invalid`-origin artifact is deliberately not a production release. A further
actual Windows OS-store/native-renderer smoke test is now being added, using
random disposable synthetic keys only; real OIDC/MFA/device acceptance remains
separate. No credential enumeration or existing OS-store deletion is performed.


### Native inventory management — 2026-10-05

Permission-aware order/stock sections; stock-only staff do not need order/menu
privileges. Inventory shows original-core item names, sellable versus held
quantities, and untracked/version-zero explicitly. Arabic/Persian integer input,
bounded search/pagination, explicit recount confirmation, stale-version guards,
late-response isolation and no mutation retries. Product labels are additive
response fields from the current catalogue; no new stock ledger or DB migration.
Order details now open immediately in a modal, rather than below100 cards.

Local verification: Flutter analyze/all44 tests, platform190 PostgreSQL tests,
Go stock and cross-language integration race tests, Go vet/build and diff checks.
Windows OS storage/native renderer/release acceptance for the previous increment
is fully green in CI37319998899; current increment needs its own remote run.
Deferred POS scope is recorded in the transformation plan, not implemented.


### Native channel controls and suspension parity — 2026-10-05

Inventory commit `eef4a7c` passed all jobs in CI37321917046. The next native
increment exposes versioned new-order channel controls with explicit confirmation,
independent `channels:manage` access and no enable controls for unfinished
WhatsApp shopping adapters. Existing WhatsApp calling/messaging is untouched.
Suspended tenants retain original-core permitted existing-order settlement;
inventory/channel changes stay blocked. Profile membership responses now include
the current restaurant display name as an additive field; IDs still route requests.
Local Flutter analyze/all49 tests and platform190 tests plus Go↔Node race pass.
This is not a POS implementation or external-account acceptance claim.


### Native catalogue read/basic edit — 2026-10-05

`d7c1c3e` passed all jobs in CI37323385900. Next increment: permission-scoped menu
section with name/category search, bounded pages and explicit edits of item name,
category, exact minor-unit price and availability. Narrow patches preserve
images/options/descriptions/settings and historical orders. Catalogue version is
captured when opening the form; stale or cross-tenant forms cannot write. Response
validation now checks mutation values, not just IDs/versions, before claiming
success. Local analyze/all55 tests pass, including Arabic/Persian decimal parsing,
read-only roles, cancellation, stale forms and unexpected success bodies.
The Windows native smoke now also exercises menu/stock/channel forms with
synthetic gateways and captures separate screenshots. Its new run remains pending;
this does not replace real HTTP/OIDC/MFA or merchant-device acceptance.


### Native category and draft-item creation — 2026-10-05

`88a1a1d` passed all jobs in CI37325002495, including the expanded actual Windows
menu/stock/channel form tests; screenshots were downloaded and inspected. New
creation forms use stable random IDs per form and the captured catalogue version.
New items start disabled with empty description/image/options for review; no
existing item or historical order is replaced. Arabic price/integer validation,
permission checks, cancellation, stale forms and non-replayed uncertainty have
local coverage. Staff summary capacity now matches the original 5000-item
catalogue bound; existing 2 MB response cap is unchanged. Native rendering keeps
50-item pages and cards use the available width after visual inspection.
Local analyze/all60 Flutter tests, platform191 PostgreSQL tests and actual
Go↔Node race integration pass. Windows creation-form smoke is added but not yet
remotely verified for this increment. POS integration remains deferred.


### Native category/options editing and feedback — 2026-10-05

`f7bc1f5` passed all jobs in CI37327358158, including Windows category/item
creation forms. Native category rename/sort now preserves IDs/assignments; detail
editing preserves option IDs and disables rather than deletes, with review-first
new options and bounded arrays. Description/options patches omit image, base price,
settings and historical snapshots. Revoked permissions mask an open details dialog;
late reads, stale forms and blocked writes have explicit guards/feedback.
The main status is a live semantic region and shows the last successful refresh.
Local analyze/all69 Flutter tests pass; actual NVDA/device acceptance is separate.

Expanded Windows smoke covers the new category/options forms. A prior creation
screenshot was captured during a text-field transition before painting settled;
logical Windows assertions passed, but the capture helper now explicitly waits
for settled frames. New screenshots must be inspected before treating that visual
check as complete. Full native-to-control-plane protocol acceptance is the next
verification focus; real account/provider acceptance is still outstanding.


### Actual native HTTP protocol acceptance — 2026-10-05

`26df634` passed all jobs in CI37332186092. An additional local live integration
now runs the actual Dart client/controller over strictly verified per-run fixture
TLS into the real Node broker and original Go/PostgreSQL core. It covers PKCE,
seeded consent, order advancement, versioned catalogue/options/category/stock and
channel operations, draft creation, refresh rotation and replay revocation/cache
clearing. The original three-order/provider deduplication checks still pass.
Platform191 tests and the Go race integration passed; verbose evidence explicitly
confirms the Dart path ran. A compile-time test-header constant typo was fixed
before these successful runs. No real identity provider, merchant device, provider
payment or production service is used. See the new native acceptance document.
Linux CI now installs checksum-pinned Flutter and runs this path alongside the
existing browser/core tests; the current increment awaits its own remote result.
