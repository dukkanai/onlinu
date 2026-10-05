# Original-core menu images

The staff item page accepts PNG/JPEG images up to 5 MiB through a CSRF-protected
multipart form. Current browser identity, active tenant and `menu:update` are
checked; customer OAuth and kitchen-only membership cannot upload. The catalog
version is checked before upload and again by the original versioned item patch.
Only the selected item's `imageUrl` is patched, not private settings or options.

The central server signs exact raw bytes with `staff:media:write` and a fixed
restaurant route. The Go service creates its own multipart envelope and invokes
the existing image normalizer. Caller Content-Type cannot change how signed
payload parts are interpreted. The original 4096-per-dimension / 16-million-pixel
limits, JPEG/PNG decoding/re-encoding, metadata removal, content hash filenames
and atomic file publication remain authoritative. There are two bounded upload
slots in each service; the signed endpoint permits larger bodies only for the
media scope and bounds those reads before buffering. Other signed requests keep
their 128 KiB limit.

Files remain in the original tenant's `restaurant-images` storage under its
recording directory. Include that volume in tenant backups. The platform does
not persist another media copy. The audited item assignment is transactional;
the file upload and catalog assignment are not one distributed transaction. A
failed or racing catalog patch can leave an unreferenced normalized image.
Previous images are not deleted. Garbage collection is not implemented here.

## Public delivery

Local menu and brand image paths returned through MCP are rewritten to the
platform's `/restaurant-media/{tenant}/{content-hash}.png|jpg` origin. Reads use
only configured restaurant origins and exact hash paths, with no credentials,
redirects or caller-supplied URL fetch. A bounded response must have the expected
image type, signature prefix and matching SHA-256. Eight concurrent reads and a
5 MiB response limit bound buffering. Staff image previews allow only this own
origin; existing external image references are not automatically fetched there.

These are public menu images, not private attachments. The platform checks that
the tenant is active on every new uncached read; browser/proxy caching lasts up
to five minutes, and the original restaurant's public media path remains its own
boundary. Suspension is not a claim of instantaneous removal from all caches.
No arbitrary remote image proxy, file-path fetch or credential forwarding exists.

## Verification and remaining acceptance

Tests use generated tiny PNGs and temporary Go media directories, never real
customer images. They cover raw-byte signatures and tampering, scope/CSRF/role
checks, SVG/oversize rejection, normalization, stale image assignment, fixed
public routes, hash/type validation, MCP URL mapping and suspended-tenant reads.
Chromium covers the image form/accept attribute and actual own-origin preview
rendering. A second loopback-only browser flow selects and submits a real binary
file through a synthetic ingress/session adapter because CDP interception omits
file parts. That native flow checks normalization, versioned assignment and
preview. HTTPS cookie/Origin isolation is tested separately by the primary
browser fixture; loopback ingress is test-only and is not a deployment pattern.
Remote execution of these new browser cases is pending for this increment.
Production storage, backups and real account acceptance remain separate gates.
