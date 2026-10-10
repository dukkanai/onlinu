# Public-file and dependency maintenance — 10 October 2026

Source baseline: e48fb4add81e196b98740f767446d5986584a90b.
This is source acceptance evidence, not deployment or production acceptance.

## Public-file boundary

Seven deliberately planted synthetic symlink cases reproduced disclosure through
actual static/media routes. No remote link-placement route or live disclosure
was established. The shared opener now walks pinned os.Root handles, rejects
hidden components and observed symlinks, compares directory and regular-file
identities, and serves the verified descriptor without reopening its pathname.
All seven refusal cases pass; six deterministic different-inode swaps are
rejected. Fourteen focused test groups cover normal uploads, trusted base
semantics, exact MIME, SPA, HEAD, ranges, 304 and canonical redirects. Independent
review found no blocker within this scope.

Public images remain public. Trusted publication writers and configured base
ownership are prerequisites. Hard links, mounts, same-inode changes and base
replacement are not prevented. A FIFO swap after Lstat can block an open; this
is not an availability guarantee against malicious local writers.

## Dependency maintenance

Go 1.26.9, x/crypto 0.56.0 and x/text 0.41.0 replace affected versions; x/sync 0.22.0
is selected by the compatible module graph. Both Go Dockerfiles and active
helper/setup recommendations agree. Historical installed-version records remain.
The completion helper now enables cgo, required by its existing race detector.

Tailwind 4.3.3, PostCSS 8.5.23, Vite 7.3.7, esbuild 0.28.2, Browserslist 4.28.7,
NanoID 3.3.18, source-map-js 1.2.2 and baseline-browser-mapping 2.11.0 resolve the
audited npm advisories. All eight production client lock entries are unchanged.
Independent review verified official registry metadata and integrity for all 53
changed registry-backed entries and all 213 dependency/optional relationships.
Lock shrinkage is primarily esbuild deduplication; no unrelated major upgrades
or new lifecycle-hook types were introduced.

## Final local verification

- Fresh client install:121 tests pass, TypeScript/Vite build passes, full npm audit 0.
- Root Go race with new isolated PostgreSQL 17:324 pass,0 fail,12 optional skips.
- Tenant Go race with separate isolated PostgreSQL 17:8 pass,0 fail,0 skip.
- Both Go modules: module verification, vet and build pass.
- Both synthetic PostgreSQL clusters confirmed stopped.
- Govulncheck 1.8 with Go 1.26.9 package and symbol scans completed successfully:
  no affected imported package or reachable vulnerable symbol. Root retains only
  module-wide GO-2026-5932 for the unused OpenPGP subtree; tenant has no findings.
- Shell/JS helper syntax and git diff whitespace checks pass.

Earlier scanner runs were killed by resource limits before findings; they were
not treated as success. The final successful updated-source scans supersede that
coverage gap. Exact-commit CI, including dedicated restore checks, remains a
publication gate. OS/container layers, Node runtime and Flutter SDK/native
dependencies are not covered by these package results. Original courier session
revocation and connected Stripe acceptance remain separately open.

## References

- https://go.dev/dl/
- https://pkg.go.dev/vuln/GO-2026-6609
- https://pkg.go.dev/vuln/GO-2026-5932
- https://go.dev/doc/articles/race_detector#Requirements
- [Current project review](PROJECT-REVIEW-20261010.ar.md)
- [Stripe rollout proposal](STRIPE-PILOT-ROLLOUT-20261010.md)
