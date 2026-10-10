# Onlinu — restaurant and ChatGPT ordering

Restaurant storefront, administration, courier operations and signed ChatGPT/MCP
commerce integration. WhatsApp Business/QR, messaging, calling, voice translation,
Chatwoot and their conversation archive were removed from this branch on 9 October 2026.

## Restore point

`before-whatsapp-removal-20261009` identifies commit
`3614be85c97744b95e25f55ac4e0e77de4b06394` before removal. It is published on the
origin repository. Create a separate worktree/branch at the tag to inspect or restore
old code; do not reset a working tree containing uncommitted work. Git does not
back up external databases, secrets, uploaded media or live provider settings.

## Current surfaces

- `/`: customer menu, pickup/delivery checkout, tracking and customer accounts.
- `/admin`: restaurant administration, menu, brand, payments, stock and couriers.
- `/courier`: scoped courier work.
- `prototype/platform/`: signed commerce/control plane, OAuth/OIDC, MCP/ChatGPT,
  staff/native integration and isolated acceptance fixtures. See its documentation
  for configured integration requirements; source presence is not production readiness.
- `prototype/admin_flutter/`: restaurant staff application prototype.

Only `web` and `chatgpt` are supported order channels. Menu/table QR codes are
restaurant features and are unrelated to removed WhatsApp pairing.

## Development

Go 1.26.4 and Node 22+. Main database configuration is `WACALLS_PG_URL`, an existing
compatibility name. Use an isolated PostgreSQL database for tests and never production
credentials. The backend retains the `<namespace>_main` database convention; it no
longer creates, migrates, connects to or drops WhatsApp session databases.

```
go test ./...
go vet ./...
go build ./...
cd client
npm ci
npm test
npm run build
```

Run the backend with `go run ./cmd/server -addr 127.0.0.1:3001` and the frontend
with `npm run dev -- --host 127.0.0.1`. Use `WACALLS_API_KEY` for administrator
authentication. Secrets stay out of Git. File-backed secrets are supported for the
administrator key and PostgreSQL URL. Restaurant media uses `WACALLS_MEDIA_DIR`;
existing `WACALLS_RECORDING_DIR` is accepted solely as an old media-directory alias.

The root Dockerfile builds a codec-free, non-root HTTP-only image. See
[deployment](DOCKER.ar.md). The old 0.3.0 offline bundle is not this version; the
0.4.0 release manifest is intentionally unbuilt until a clean image/archive is verified.
No deployment, real payment or external account revocation is part of this cleanup.

## Data safety and limitations

Existing historical database tables, recordings, keys and provider accounts are not
deleted. Removed routes cannot access them. Back up and review them separately before
any irreversible purge. Personal WhatsApp tools outside this repository are unaffected.

Current prioritized work and review: [10 October review](plans/PROJECT-REVIEW-20261010.ar.md).
Implementation history and remaining launch work: [status](plans/IMPLEMENTATION-STATUS.md).
Earlier audit documents describe their dated scope and are historical evidence.

## License and attribution

AGPL-3.0; see LICENSE and LICENSE.WaCalls. This project derives from AstraCalls/WaCalls.
Original copyright/license notices remain even though the calling subsystem was removed.
