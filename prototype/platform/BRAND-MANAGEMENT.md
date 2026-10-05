# Original appearance draft management

Status: next parity increment in progress; separate from verified refund work.

Reuse the original appearance state's independent version, draft, publication and
previous-version restore. Start with the five storefront templates, typography,
layout, text size, corner/shadow/image-fit choices, hero visibility and intro text.
Preserve colors and media not explicitly edited; no automatic public publication.

Reads use current settings-read authority. Draft/publication/revert commands
require current settings-read and settings-update authority, exact signed action,
explicit reviewed version and separate confirmation. A draft stays private until
published. Publishing/restoring preserves the current menu, tax, service policy,
orders, table capabilities and payment/provider configuration.

The original draft save gains a transaction matching publication's catalog-first
lock order, plus actor attribution in the same transaction. Audit failure must
roll back the appearance mutation. New partial-draft commands bind both observed
catalog and appearance versions so merging legacy effective appearance cannot
silently replace newer settings. Existing legacy entry points retain their public
contract and default behavior without an added caller-supplied role.

Tests must cover old drafts/font inheritance, five-template validation, invalid
contrast, stale review, parallel draft CAS, audit rollback, published/private
separation and original order/money preservation. Browser and native confirmation,
revocation/lifecycle, actual Dart/Node/Go, Chromium and Windows acceptance remain
required. No production publication or real merchant configuration is performed.

## Backend checkpoint

Original-core signed GET and draft/publish/revert commands plus the central
browser/native staff API are implemented. The first edit projection deliberately
excludes media/color changes; unedited appearance fields are preserved. Template
and inherited font validation remain original-core rules.

Local PostgreSQL race tests cover review requirements, independent catalog/state
versions, partial preservation, draft privacy, publication/restore isolation,
audit rollback and the original concurrent/legacy/font regressions. Actual
Node-signed HTTP exercises draft, stale publication, successful publication and
restore. All216 platform tests, React80/build and Go vet pass locally. Native
and browser appearance forms remain the next increment; remote CI is pending.

## Reviewed browser/native forms (local verification)

The central browser and Flutter core client now expose a settings-authorized
appearance section. Saving a private draft, publishing it and restoring the
previous published appearance are separate reviewed actions. The editor changes
only selected template/typography/layout/intro choices; existing colors/media
stay untouched. Publication explicitly warns that the entire stored draft,
including original-editor colors/media, becomes public.

Native inline choices avoid transient private dropdown overlays. Current grants,
both versions, foreground freshness and duplicate-click guards are checked;
unknown writes only refresh the existing state and never repeat a POST. Browser
forms have CSRF-protected review/execute stages and 303 GET recovery.

Local121 Flutter tests,217 platform tests, real PostgreSQL/race regressions and
actual Dart TLS/Node/original-Go draft/publish/restore pass. Chromium form flow
and `windows-brand-draft-review.png` are new remote acceptance checks, not yet
claimed from local HTTP/widget tests. Native rendering does not implement a
customer-template visual preview; the original storefront renders the five
published templates. Color/media editing remains in the original editor.

## Verified checkpoint — 2026-10-05 23:22 UTC

Backend3c43edf passed CI37386151595; browser/native UI c5446aa passed all
CI37387124412 jobs, including actual Chromium save/cancel/publish/restore and
Windows renderer/store/build. The Arabic RTL draft-review screenshot was
inspected and is readable without clipping. Local121 Flutter and217 platform
test counts correspond to this UI increment. The entire SaaS remains incomplete;
no production appearance, real credentials or merchant state was changed.
