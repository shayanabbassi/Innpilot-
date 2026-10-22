# Security review

Status: slice 6.8 (2026-10-22), Prompt D. A threat-model-driven review of tenant isolation, roles, authentication
and sessions, object access, uploads, injection, secrets, dependencies and operations, with automated evidence.
Every finding is fixed, or listed for your explicit acceptance. An independent review by a security professional
before paid customers rely on InnPilot is still recommended (playbook working rules).

## Threat model (summary)

| Asset                                           | Main threats                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Guest personal data, identity numbers and scans | Another hotel or an unauthorised staff member reading them; leaks through logs, errors, exports |
| The ledger, folios, cash and invoices           | Tampering, duplicate or lost money movements, deleted history                                   |
| Accounts and sessions                           | Password guessing, session theft, cross-site requests, privilege escalation                     |
| The platform (operators' console)               | Operators reaching hotel data without a recorded, time-bound reason                             |
| Backups, files, secrets                         | Theft of a bucket or a backup, secrets in the repository or the browser                         |

Actors: an anonymous internet user; a staff member of one hotel trying to reach another hotel or more than their
role allows; a former staff member; a platform operator; someone who obtains a backup, a log or a storage bucket.

## Controls and evidence

| Control                                                                                                             | Evidence                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Every route declares an access policy**, deny by default                                                          | route-policy.test; security-probe.e2e (all 200 routes)                                                                  |
| **Tenant isolation**: row-level security in the database, tenant from the session only, never from the request      | isolation.e2e (SEC-001); security-probe.e2e: 134 routes with tenant A ids, all 404 for tenant B; foundation.integration |
| **Role permissions** enforced by the server for every route                                                         | rbac.e2e (SEC-002); security-probe.e2e: 165 permission routes, each refused (403) for a role without it                 |
| **Unauthenticated access** refused                                                                                  | security-probe.e2e: 195 routes, all 401                                                                                 |
| **CSRF**: origin check and a per-session token on every state change; SameSite cookies                              | security-probe.e2e: 108 state-changing routes, refused without the token and from a foreign origin                      |
| **Sessions**: `__Host-` Secure HttpOnly cookies, idle and absolute expiry, revoked on password change and reset     | auth.e2e, recovery.e2e, smoke test                                                                                      |
| **Brute force**: rate limits, account lockout, two-step verification required for owners, managers, accountants     | auth.e2e, app.smoke.test (rate limit), access.test                                                                      |
| **Platform operators**: separate sign-in, time-bound audited access grants                                          | platform.e2e; security-probe.e2e: hotel sessions refused on all 10 operator routes                                      |
| **Identity data**: encrypted at rest, revealed one at a time with a reason, audited; never in lists or logs         | guests.e2e, pii-logging.e2e                                                                                             |
| **Files**: private bucket, encrypted, type from content, size limit, 5-minute user-bound links (SEC-003)            | attachments.e2e, jobs.e2e                                                                                               |
| **Injection**: parameterised queries only; validated input (Zod) on every route                                     | code review; dependency fix F-2 below                                                                                   |
| **Error handling**: no stack traces or database messages to clients; error reports scrubbed                         | app.smoke.test, monitoring.e2e, scrub.test                                                                              |
| **Logs**: secrets, cookies, identity numbers, query strings and download links removed                              | pii-logging.e2e                                                                                                         |
| **Headers**: CSP, HSTS, frame denial, nosniff, no server banner                                                     | smoke test against the production stack                                                                                 |
| **Production configuration**: unsafe settings and a database role that bypasses row-level security refuse to start  | config.test, production-start.e2e                                                                                       |
| **Secrets**: none in the repository or the browser bundles                                                          | `scripts/secret-scan.mjs` (in CI)                                                                                       |
| **Dependencies**: no known vulnerabilities                                                                          | `pnpm audit` (in CI, moderate and above)                                                                                |
| **Supply chain**: GitHub Actions pinned to commits; images built in CI with provenance and SBOM; base images pinned | `.github/workflows/*`, Dockerfiles                                                                                      |
| **Backups**: encrypted to a key the server never holds; restore drill checks integrity                              | backup.e2e, docs/backup-and-restore.md                                                                                  |

The probe (`apps/api/test/security-probe.e2e.test.ts`) reads the application's own route table, so a route added
later is probed automatically. It found no access-control failure and no server error.

## Findings

| #    | Finding                                                                                                                                                                                                    | Severity                      | Status                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| F-1  | `drizzle-orm` 0.44 had an SQL injection advisory (improperly escaped identifiers). InnPilot builds identifiers only from code, never from input, so it was not reachable, but it ships in production       | High (advisory)               | **Fixed**: upgraded to 0.45.3                                                                          |
| F-2  | Next.js 15 pins a PostCSS with source-map file-read advisories (build time only; our own CSS)                                                                                                              | High (advisory, build only)   | **Fixed**: PostCSS overridden to 8.5.28                                                                |
| F-3  | The test runner (Vitest 3, Tinypool) had code-execution advisories (development only, never shipped)                                                                                                       | Critical (advisory, dev only) | **Fixed**: Vitest 4.1.12; full suite passes                                                            |
| F-4  | Reading a stay after check-out answered 500 (found by the probe's positive control); no data exposed                                                                                                       | Medium (availability)         | **Fixed**, with a regression test                                                                      |
| F-5  | Failed database queries put their parameter values (names, phone numbers) into the error log                                                                                                               | Medium (privacy)              | **Fixed** in 6.6: reports drop the parameter list; tested                                              |
| F-6  | GitHub Actions referenced by moving tags                                                                                                                                                                   | Low (supply chain)            | **Fixed**: pinned to commit hashes                                                                     |
| F-7  | The Content Security Policy allows inline scripts (`'unsafe-inline'`), which Next.js needs without nonces. Mitigated: React escapes output, no user-supplied HTML is ever rendered, no third-party scripts | Low                           | **For your acceptance**; hardening: nonce-based CSP                                                    |
| F-8  | Rate limits are counted in each API process's memory: with several API instances, the effective limit multiplies (lockout after failed sign-ins is in the database and unaffected)                         | Low                           | **For your acceptance** for a single-instance pilot; with several instances, a shared store for limits |
| F-9  | A download link is a URL: it can end up in the browser's history. It expires after 5 minutes and works only for the signed-in person it was issued to                                                      | Low                           | **For your acceptance**                                                                                |
| F-10 | The nightly backup reads the database as its owner; a dedicated read-only role would narrow that                                                                                                           | Informational                 | Hardening item                                                                                         |
| F-11 | No malware scanning of uploads (types are checked from content; PDFs with scripts are refused)                                                                                                             | Informational                 | Add the provider's scanning service once hosting is chosen (D17)                                       |

No open critical or high findings.

## Still to do (outside this repository)

- Penetration test or review by an independent security professional before paid customers rely on InnPilot.
- Repeat the probe and smoke test against staging once it exists (D17).
- Your acceptance of F-7, F-8 and F-9, recorded below.

| Finding | Accepted by | Date | Until / condition |
| ------- | ----------- | ---- | ----------------- |
| F-7     |             |      |                   |
| F-8     |             |      |                   |
| F-9     |             |      |                   |
