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
