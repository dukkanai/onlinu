# Pinned public Saudi geography inputs

Upstream: https://github.com/homaily/Saudi-Arabia-Regions-Cities-and-Districts

Revision: `7e322945fa9f6d696a54ba3e9038e0e750e9692d`.
The three JSON files come from upstream `json/`; `LICENSE` is unchanged and
`UPSTREAM-README.md` is the unchanged upstream `README.md`. Upstream identifies
the license as GPL-2.0. Preserve the supplied license and attribution.

All five files are byte-for-byte matches for the SHA-256 values already pinned
in `cmd/server/restaurant_geography.go`. Restored on 2026-10-05; no source-data
edits or hash changes. Contains 13 regions, 4,581 cities and 3,732 districts.
Lite data has no geographic boundaries or coordinates and is not an official
address verification service. See `plans/SAAS-LAUNCH-GATES.ar.md` for the existing
source/rights review constraints; this restoration does not resolve those gates.

These are public reference inputs, not a database export or production data.
Git, Docker context and source packaging allow only the six named files here;
other runtime data remains excluded. To verify the input hashes, record counts
and relationships, run from the repository root:

    go test ./cmd/server -run '^TestRestaurantGeographyPinnedSourceAndValidation$' -count=1

Docker images include these files at `/app/data/saudi-geography`. Import remains
opt-in using `RESTAURANT_GEOGRAPHY_DATA_DIR=/app/data/saudi-geography`; this change
does not turn on imports or run any database migrations. For development use the
absolute path to this directory with an isolated test database only.

Recover exact inputs from the pinned revision, never a moving default branch.
Do not substitute an updated upstream dataset without reviewing it and changing
the pinned checksums and tests deliberately.
