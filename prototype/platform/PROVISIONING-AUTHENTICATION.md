# Bounded loopback runtime authentication

The private `createProvisioningAuthentication` capability checks the health and
administrator authentication of the exact loopback port supplied by the trusted
runtime verifier. Input accepts only a tenant ID and unprivileged port; callers
cannot supply a host, URL, path, headers or redirect policy. It is not a public
API or credential-provisioning service.

A single overall deadline covers the observations. Direct `node:http` uses IPv4
127.0.0.1, no pooled agent, proxy, fetch dispatcher, redirect following or retries.
Response headers are bounded to8KiB; response bodies are destroyed at headers,
not retained. Cookies and catalogue content are ignored. It checks health200,
missing-key401, wrong-key401 and approved-key200 in that order. The wrong probe
cannot equal the approved key. All failures are sanitized without paths, key
values, socket diagnostics or response content.

A trusted `loadAdministratorKey(tenantId, { signal })` capability supplies the
already-approved key and must honor the supplied deadline. This module does not
read files, create credentials, persist keys, change permissions or decide who
may access credentials. The key is held only in process/request memory, which
is not protection from a compromised process. The caller must retain host
exclusion, current journal authority and before/after owned-runtime inspection;
HTTP status alone cannot identify the process listening on a port.

The journal/Docker fixture now invokes this shared capability using only its
public synthetic fixture key and an exact tenant binding. Its health check is
preserved and missing-key rejection is added. Production secret access and live
credential use are not accepted by these tests.

Seven real loopback test groups cover request order and fixed target, malformed
input, cancellation, redirects/open endpoints, invalid authentication, silent
socket deadlines, oversized headers, negative-key collision and input mutation.
Local platform regression:255 pass,12 database skips. Actual Docker acceptance
for this increment remains pending.


Loopback-auth acceptance: `dfebcaebea60489d63c2efe4057ccd4165f15265`
passed all five jobs in [CI37554750785](https://github.com/dukkanai/onlinu/actions/runs/37554750785),
verified 2026-10-07 01:07 UTC. Both actual successful and unknown-reply runtime
verification paths passed the shared health/missing-key/wrong-key/valid-key
transport. Four source-bound runtime reports were inspected and both immutable
receipt hashes and job/worker/tenant/plan bindings independently verified.
Synthetic local image ID:
`sha256:4e7e053fb159789289d686b9720b0f3027102e7c022f3241db6ff8741af5e35b`.
Production key loading, registry publication, activation and deployment remain
separate; no real credential or provider account was used.
