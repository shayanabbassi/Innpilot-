# Production readiness

Status: slice 6.8 (2026-10-22), Prompt E. The launch checklist (05 Security & Deployment Runbook §7) item by item,
the acceptance matrix, and the pilot runbook. **Done** means proven here with the evidence named; **Yours** means it
needs an account, a decision or a qualified person that this repository cannot supply. Fill in owner and date as each
is done.

## Launch checklist (05 §7)

| #   | Item                                                                                     | Status                                            | Evidence or what is needed                                                                                                                                                                                     | Owner | Date |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| 1   | Production domain, TLS, DNS, environment variables and secret rotation configured        | **Yours** (tooling done)                          | Stack, TLS proxy, env template, start-up checks and rotation steps: docs/deployment-runbook.md, docs/incident-response.md (Containment). Needs D17, the domain and the secrets                                 |       |      |
| 2   | Tenant isolation, permission matrix, backup restore, rate limits and audit trails tested | **Done** here; repeat on staging                  | security-probe.e2e (all routes), isolation.e2e, rbac.e2e; restore drill (docs/backup-and-restore.md); rate limits app.smoke.test; audit trails across the e2e suites. Staging repeat after D17                 |       |      |
| 3   | Initial chart of accounts and tax configuration reviewed by accountant / customer        | **Yours**                                         | docs/accounting-review.md (questions 1 to 12 and sign-off table)                                                                                                                                               |       |      |
| 4   | Data import dry-run and rollback tested; opening balances reconcile                      | **Partly done** (D20: no import)                  | Manual set-up through onboarding and the opening-balances wizard (cash.e2e). The pilot hotel's opening trial balance is reconciled with the accountant (accounting review, sign-off table)                     |       |      |
| 5   | Monitoring and alert destinations verified; support escalation owner named               | **Done** locally; **yours** for real destinations | Alert rules tested and a real alert delivered locally (docs/incident-response.md). Real destinations, owners and the test alert: yours                                                                         |       |      |
| 6   | Customer terms, privacy notice, data-processing terms and retention policy reviewed      | **Yours** (legal adviser)                         | Retention periods to confirm: backups (35 daily, 12 monthly), audit log, guest records, invoices                                                                                                               |       |      |
| 7   | Demo data removed; admin credentials rotated; no debug mode or open database port        | **Partly done**                                   | Production refuses debug logging and unsafe settings (config.test). The stack publishes no database port (deploy/compose.yml). Never run the demo seed in production; rotate any credential used during set-up |       |      |

Also from the runbook (§3, §4, §6) and the PRD:

| Item                                                                               | Status             | Evidence or what is needed                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Backups automated, encrypted, retention documented, backup job monitored           | **Done** (tooling) | docs/backup-and-restore.md; backup alerts in docs/incident-response.md. Key pair and bucket: yours         |
| Restore into an isolated environment, verify sign-in and ledger, record            | **Done** locally   | Drill record in docs/backup-and-restore.md; staging and production drills: yours                           |
| RPO / RTO targets agreed with the hosting provider                                 | **Yours**          | Targets proposed: RPO 15 min (point-in-time recovery), RTO 4 h (drill: 18.5 s for the 100-room year)       |
| CI, staging deploy, reviewed migrations, smoke tests, rollback plan, release notes | **Done** (tooling) | .github/workflows, deploy/release.sh, scripts/smoke.mjs, docs/deployment-runbook.md. Not yet run on GitHub |
| Dependency scanning, static analysis, code review, patching, incident contact      | **Done** / yours   | `pnpm audit` and secret scan in CI, lint and types in CI; incident contact: yours                          |
| Load: p95 common reads under 500 ms; consistent writes under concurrency           | **Done** locally   | docs/phase-6-load-test.md (p95 232 ms); staging run: yours                                                 |
| Security review, no open critical or high findings                                 | **Done**           | docs/security-review.md; F-7 to F-9 await your acceptance; independent review recommended                  |
| Tax and record-keeping obligations confirmed for the hotel and location (§6)       | **Yours**          | Accountant and legal adviser. InnPilot must not be described as integrated with any tax authority          |
| Urdu (D19)                                                                         | Deferred           | English first; Urdu after the pilot                                                                        |

## Acceptance matrix (06 §2)

Unchanged since the Phase 5 exit report (every row passed there with the tests named), except:

- **SEC-003** (unauthorised user downloads a guest document; signed URL not reusable after expiry): was partial
  (no files existed). Now **passed**: attachments.e2e (no access without the permission, link useless to anyone else
  or after expiry, no cross-tenant access, every download of an identity scan audited); security-probe.e2e.
- **Concurrency** (QA §1: simultaneous booking, duplicate payment retries, competing numbering): **passed** under
  load, docs/phase-6-load-test.md.

## Pilot runbook

Before the pilot hotel's first day:

1. Provision staging, run the release, the smoke test, the probe-equivalent checks, the restore drill and a load run
   there; record results in the respective documents.
2. Provision production (separate account credentials, database and buckets from staging), with the backup key pair
   made and the private key stored offline.
3. Create the hotel (`tenant:create`), with the owner's own email and a temporary password given in person; the
   owner enrols two-step verification at first sign-in.
4. Set up through onboarding: property, rooms, rates, taxes (as confirmed by the accountant), cash accounts, staff.
5. Enter opening balances; review the opening trial balance with the accountant.
6. Confirm alert destinations with a test alert; name the support contact and tell the hotel how to reach them.
7. Train the staff (front desk, cashier, housekeeping, accountant) on a copy, not on production.
8. Day 1: a team member on call; check the dashboard, night audit and backups at the end of the day.
9. First weeks: daily check of failed jobs, alerts and support requests; weekly reconciliation review with the
   accountant; fix what the pilot finds before a second hotel.
