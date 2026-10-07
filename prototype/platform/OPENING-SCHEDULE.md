# Structured restaurant opening schedule

The original Go core now owns a separate, default-disabled schedule. The legacy
`openingHours` profile string stays informational; it is never parsed as policy.
Saving old catalogue/profile documents cannot erase the structured schedule.

The bounded document uses `Asia/Riyadh`, seven arrays indexed Sunday=0 through
Saturday=6, and up to eight non-overlapping intervals per day. Each interval is
`{startMinute,endMinute}` within 0..1440, with an inclusive start and exclusive
end. Overnight service is explicitly split across the two calendar days. Up to
64 unique ISO-date exceptions replace their entire Saudi calendar day; an empty
exception closes that date. No timezone or clock comes from a customer request.

Staff writes require the existing signed `staff:settings:update` scope, explicit
review, all seven days, a non-omitted enabled flag, and the expected schedule
version. Updates and their actor/scope audit commit together; stale versions
fail. Restart initialization never overwrites configured hours. Invalid stored
policy fails closed instead of silently reverting to an unrestricted schedule.

- GET `/platform-api/staff/opening-schedule`: signed `staff:settings:read`.
- POST on the same path: reviewed replacement with `expectedVersion` and the
  fields above; signed `staff:settings:update`.
- GET `/storefront-api/opening-status`: public no-store snapshot with evaluation
  time, policy version, timezone, and combined manual/scheduled acceptance.
  `withinHours` is null when the schedule is disabled, rather than inventing
  published opening hours. This snapshot does not guarantee stock, service-mode
  availability, coverage or payment availability; checkout remains authoritative.

Quotes/previews check the same policy. New-order transactions take a shared
schedule lock so a configuration update cannot race past the gate. Durable
receipt recovery happens before that gate; a retry of an already accepted order
still succeeds after closing. Existing tracking, fulfillment and settlement are
not newly blocked or rewritten. The original manual service switch remains an
additional restriction; an enabled schedule cannot override a manually closed
restaurant.

This increment supplies the core, signed API and authoritative order enforcement.
Browser/Flutter editors and directory filter integration remain separate work.
No production database or restaurant setting is changed by this development.
Local pure policy tests, formatter, vet and build are recorded separately from
actual PostgreSQL/HTTP/CAS/audit/stock/idempotency/lock tests in hosted CI.

The next increment adds `/api/restaurants/:id/staff/opening-schedule` shared by
browser and native staff transports, with both settings read/update rechecked
following streamed body parsing. Signed core responses must exactly match the
canonical reviewed replacement and next version; uncertainty is never replayed.
The browser `/manage/:id/opening-schedule` uses a separate non-mutating review
page, explicit execution checkbox, current CSRF/permissions and CAS. Cancel
reloads durable state. Days use bounded HH:MM-HH:MM comma-separated intervals;
date exceptions are explicit `YYYY-MM-DD = intervals`, including empty closure.
Actual HTTP/Chromium acceptance and screenshot review are pending CI. There is
no Flutter schedule editor or public-directory open-now filter in this increment.

Flutter now has an independent opening-hours management section using the same
staff API. The editor retains the loaded schedule revision and tenant, discards
cancelled edits, has a distinct review state and confirmation checkbox, and
blocks stale/offline/cross-section saves. A successful-looking malformed response
is treated as uncertain and not retried. All 155 local Flutter unit/widget tests
pass; actual Dart HTTP and Windows native renderer acceptance awaits CI.

The public adapter now exposes a fresh snapshot to
`get_restaurant_opening_status` in the original-core MCP mode. It checks
publication both before and after the bounded read, rejects contradictory or
stale/future timestamps, and accepts no customer-selected time. This read does
not mutate any restaurant or payment state. Full-directory open-now filtering
is not yet implemented; do not claim all restaurants have been checked.

A separate `search_open_restaurants` tool now checks a bounded, identifier-sorted
page of published candidates. Query/cuisine narrow the source list; `limit` is
1..20 (default20), and `after` resumes after the returned `nextAfter` with the same
filters. The response reports checked/closed/unconfigured/unavailable counts and
hasMore. Only configured schedules within hours AND manual intake acceptance
qualify. Unknown/unreachable/unconfigured hours are never guessed open. Up to
five reads per search and two active searches per process bound work; overload
fails rather than creating a queue. Every core read retains publication and
freshness checks. Pages are changing snapshots, not a comprehensive atomic view
or stock/delivery/payment guarantee. There is no automatic polling or full-list
fan-out. Local cases and actual core search/restore integration are separate;
hosted aggregate acceptance for the search increment remains pending.
