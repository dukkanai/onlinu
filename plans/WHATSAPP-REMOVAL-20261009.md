# Restaurant channel removal — 9 October 2026

## Authorized scope and rollback

The owner requested a restore point, then removal of restaurant WhatsApp Business
API and QR integrations, retaining restaurant and ChatGPT interfaces. Public push
of the restore tag and tested cleanup branch was separately approved.

Restore tag: `before-whatsapp-removal-20261009`
Commit: `3614be85c97744b95e25f55ac4e0e77de4b06394`
Cleanup branch: `refactor/restaurant-chatgpt-only`

To inspect the prior version without replacing current work:

```
git fetch origin --tags
git worktree add ../onlinu-before-whatsapp before-whatsapp-removal-20261009
```

This is a source-code restore point, not a database/secret/media backup. No reset,
production deployment, external account revocation or data purge was performed.

## Removed

- WhatsApp QR/passkey/code pairing, account sessions, messages/groups/contacts,
  Meta webhooks/Business API/calling, WebRTC/VoIP/audio/video/translation.
- Chatwoot and the related WhatsApp conversation/recording archive.
- Private WhatsApp ordering proposal/inbox/binding/authority/source/dispatch/
  checkout-collection work, tests and active backlog.
- Calling UI, WhatsApp and conversation-archive admin panels, widget/public API
  descriptions/passkey extension, native codecs and calling dependencies.
- Synthetic WhatsApp settings and platform/native controls for removed channels.
- Runtime calling keys, session-database creation, media ports and codec image stages.

## Preserved

- Restaurant catalogue, image assets, ordering, immutable receipts/idempotency,
  stock, payments/refunds, customer accounts, courier and staff permissions.
- Website and signed ChatGPT/MCP order channels; channel pause affects only new work.
- Restaurant/menu QR codes, distinct from removed account pairing.
- Legacy database rows and media remain intact and inaccessible through removed APIs.
  Old channel rows are hidden/rejected, not destructively purged.
- Existing database/volume/module naming where changing it risks data detachment.
- Licenses and dated historical audits, with current scope overrides.
- All personal messaging tools outside this repository.

## Acceptance

Local frontend build and 71 frontend tests pass. Deployment unit tests pass (86).
Full isolated PostgreSQL Go race suite, actual-main startup, Node/core signed
HTTP parity, tenant Go tests, platform tests with database coverage, go vet and
go build pass locally. Hosted acceptance is pending. Browser execution on the local
sandbox is blocked by Unix socket restrictions; hosted CI must establish browser
and native-client acceptance. Do not represent local browser checks as passed.

The old offline 0.3.0 image/archive is not the cleaned application. The 0.4.0 manifest
is deliberately `unbuilt`, with no fabricated digest. Building and accepting a new
runtime image and installer remains separate from production deployment.
