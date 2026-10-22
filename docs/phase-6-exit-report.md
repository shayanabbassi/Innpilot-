# Phase 6 exit report — deployment and testing

Date: 2026-10-23 · Branch: `phase-1-foundation` · Plan: [phase-6-plan.md](phase-6-plan.md) · **Accepted by the owner
2026-10-23, with the open items as listed below.**

Phase 6 is the playbook's last phase, "Hardening" (playbook phases 0 to 7; this project grouped housekeeping and
night audit into earlier phases, so its numbering ends at 6). With it, the build plan is complete. What remains is
the pilot, and the items below that need hosting (D17), accounts or qualified people.

## Slices delivered

| Slice | Scope                                                                                                                   | Commit  |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ------- |
| plan  | Slices, design decisions P6-1 to P6-11, owner decisions D17–D20                                                         | d262793 |
| 6.1   | Account recovery (D18): own password change, manager-issued resets, session list and end, operator password change      | ca091e0 |
| 6.2   | Private file storage and attachments: expense receipts, guest identity scans, 5-minute user-bound links (SEC-003, D12)  | 765701c |
| 6.3   | Postgres job queue; exports prepared in the background; expired-file clean-up                                           | ef7bae8 |
| 6.4   | Production images, provider-neutral stack, release script, smoke test, CI and release pipelines, start-up safety checks | 169a98d |
| 6.5   | Encrypted nightly backups, retention, the restore drill with integrity checks                                           | 9ee0a41 |
| 6.6   | Health and readiness, metrics, scrubbed error reports, alert rules, monitoring stack, incident response runbook         | 470bbfb |
| 6.7   | Load test on the 100-room year                                                                                          | 1383ed4 |
| 6.8   | Security, accounting and production-readiness reviews                                                                   | 4868ba3 |
| —     | Exit gate: every check and drill re-run on the final code, the performance table written to a file again, this report   | this    |

Owner decisions applied: D17 hosting undecided (everything provider-neutral), D18 manager-issued resets, D19 English
first, D20 manual set-up. Findings and refinements made while building are under "Notes from the build" in the plan.

## Test run

Executed 2026-10-22 (UTC) on 4868ba3, local Postgres 16, storage gateway and Docker; all successful:

| Run                                                         | Result                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `lint`, `typecheck`, `build`           | Passed                                                                                                                                   |
| Unit (`pnpm test`)                                          | 196 passed (money 25, contracts 65, web 22, api 84)                                                                                      |
| Database and end-to-end (`pnpm test:integration`)           | 492 passed (db integration 106, API end-to-end 386)                                                                                      |
| Secret scan (`scripts/secret-scan.mjs`)                     | 458 tracked files and 107 browser bundle files, against 17 local secret values: none found                                               |
| Dependency audit (`pnpm audit --audit-level moderate`)      | No known vulnerabilities                                                                                                                 |
| Alert rule tests (`promtool test rules`)                    | Success: every alert fires on its signal, quiet cases stay quiet                                                                         |
| Restore drill, 100-room year                                | Passed in 17.1 s, all 8 checks (below)                                                                                                   |
| Load test, 100-room year                                    | Passed: thresholds met, every consistency check (below)                                                                                  |
| Report performance, 100-room year                           | Every read p95 under 500 ms (slowest: dashboard 252 ms)                                                                                  |
| Production-like stack (`deploy/local/up.mjs --alert-drill`) | Images built; release with encrypted backup and 26 migrations; smoke test 6/6; restore drill passed; monitoring up; real alert delivered |

New test files this phase: `recovery.e2e`, `attachments.e2e`, `jobs.e2e`, `backup.e2e`, `monitoring.e2e`,
`production-start.e2e`, `security-probe.e2e`, and unit tests for storage signing and file checks, backup format and
retention, production configuration and the scrubber; plus the performance runs `restore-drill`, `load` and
`reports`.

## Exit gate

| Gate item                                                                  | Status                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore drill recorded with integrity checks passing (locally here)        | **Passed** locally; staging and production yours | 100-room year: backup 9.1 MB encrypted, restored in 14.3 s, 8 of 8 checks (migrations 26, 190,935 rows matched, trial balance on 24,391 journals, 12,134 folios against their ledger lines, cash accounts, audit log, row-level security, sign-in), total 17.1 s against a 4-hour target. Also in the production-like stack. Record: docs/backup-and-restore.md                                             |
| No open critical or high security findings                                 | **Passed**                                       | docs/security-review.md: probe of all 200 routes (195 unauthenticated → 401; 134 cross-tenant with real ids → 404; 165 role bypass → 403; 108 state changes refused without the CSRF token and from a foreign origin; 10 operator routes refuse hotel sessions; no server error). High and critical findings fixed (dependency upgrades, a 500 on a closed stay). F-7, F-8, F-9 (low) await your acceptance |
| Accountant sign-off on the accounting review                               | **Open: yours**                                  | docs/accounting-review.md: every flow traced to its journal and tests; 12 questions and the sign-off table for the accountant                                                                                                                                                                                                                                                                               |
| Production-readiness checklist complete, or each open item owned and dated | **Open: owners and dates are yours**             | docs/production-readiness.md: each item has its status and evidence; the open ones (domain and secrets, accountant, legal terms, real alert destinations, staging runs) need a name and a date                                                                                                                                                                                                              |
| Load test passing                                                          | **Passed** locally; staging yours                | 4,818 requests in 184 s, none unexpected; common reads p95 209 ms (target 500 ms), writes p95 371 ms, reports p95 743 ms; last room: 1 of 30 confirmed; one deposit retried 20 times: 1 payment, 1 journal; 375 payments for 375 keys; receipts RCT-1 to RCT-375 gapless; ledger checks intact. docs/phase-6-load-test.md                                                                                   |
| Alerts verified to reach their destinations                                | **Passed** locally; real destinations yours      | With the API stopped on purpose, InnPilotApiDown reached the test receiver after 161 s and its resolution after 189 s; 13 rules loaded; promtool tests pass. Your destinations and the test alert: docs/incident-response.md                                                                                                                                                                                |
| SEC-003 complete                                                           | **Passed**                                       | attachments.e2e (no access without permission, link useless to others and after expiry, no cross-tenant access, identity-scan downloads audited); security-probe.e2e                                                                                                                                                                                                                                        |
| Account recovery in place                                                  | **Passed**                                       | recovery.e2e (own change, manager-issued reset, temporary password works once and expires, sessions ended, audit without secrets, tenant and role negatives); browser-checked                                                                                                                                                                                                                               |
| All suites green in CI                                                     | **Not run on GitHub**                            | Every CI job's steps pass locally on the final code (table above). The workflows have never run on GitHub: the repository has not been pushed. Push and confirm the first run                                                                                                                                                                                                                               |

## Gaps and limits (stated plainly)

- **Nothing has run outside this laptop.** Staging, production, a real domain, managed database and storage, the
  CI and release workflows on GitHub, the staging restore drill and load run all wait on D17 and your accounts.
- **Local substitutes.** MinIO no longer publishes images, so local storage is the Versity S3 gateway; the API
  speaks plain S3 and is not tied to either. Locally the database tools run inside the database container
  (`PG_TOOLS_CONTAINER`); CI and the images use them directly.
- **The load test** ran the API in the test process with rate limits off (one load generator); it is a floor.
- **Not built:** email self-service password recovery (D18 chose manager-issued resets), virus scanning of uploads
  (with the provider, after D17), Urdu (D19), data import (D20).
- **Reviews are engineering reviews.** An independent security review and the accountant's sign-off are still
  needed before paid customers rely on InnPilot (playbook working rules).

## Your next steps

1. Accept or reject F-7, F-8 and F-9 (docs/security-review.md).
2. Choose the hosting provider and region (D17); then provider templates follow as a short slice.
3. Push the repository and confirm the first CI run.
4. Give the accountant docs/accounting-review.md; record the answers and sign-off.
5. Ask the legal adviser about terms, privacy notice, retention periods and breach notification.
6. Name the incident owner, technical responder and hotel support contact (docs/incident-response.md).
7. Then the pilot runbook in docs/production-readiness.md.
