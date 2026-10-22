# Phase 6 — Deployment and testing: slice plan

Status: **All slices delivered; exit report: [phase-6-exit-report.md](phase-6-exit-report.md)** · Builds on: Phase 5 (accepted 2026-10-21, e3fd599)

Scope: what stands between the built product and a pilot hotel: account recovery, real file storage, background
jobs, production builds and environments, backups with a tested restore, monitoring and alerts, a load test, and
the three reviews of the playbook (Prompt C accounting, Prompt D security, Prompt E production readiness).
Sources: 05 Security & Deployment Runbook §1–7, 02 Technical Architecture §1, §7–10, PRD §8–9 (NFRs, launch
criteria), 05 QA plan §1, §4–5, 06 Test Strategy §1 and §4, playbook phase table and prompts C–E, Phase 0
assessment (questions 6 and 7), and what earlier phases carried forward (SEC-003 signed links, D12 attachments,
background exports, load under concurrency).

**What I can and cannot do.** I can build and test everything that runs on the infrastructure: production images,
infrastructure templates, the deployment pipeline, backup and restore scripts, alert rules, load tests, and the
review reports. I can prove each locally, including a real restore drill. I cannot create the cloud account,
domain, TLS certificates or production secrets: those need you (or whoever holds the accounts). Each slice says
which steps are yours, and the exit report will list exactly what was proven locally and what still has to be run
in staging and production.

Every slice ships as before: code, tests (unit, database, end-to-end, with tenant and role negatives), all checks,
browser check where there is a screen, one commit.

---

## Design decisions (defaults unless you say otherwise)

| #     | Topic                | Decision                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6-1  | Account recovery     | PRD §8 requires password recovery and a recovery screen; today there is none. Users change their own password (current password + MFA where enrolled); an owner or manager can issue a one-time reset for a staff member, which forces a new password at next sign-in and ends that person's sessions. Self-service email recovery depends on D18.                                    |
| P6-2  | File storage         | Private, S3-compatible object storage (MinIO locally, the provider's storage in the cloud). Keys carry the tenant and property; files are never public. Downloads go through the API's permission check and return a short-lived signed link (SEC-003). Allowed types: PDF, JPEG, PNG; size limit; type checked from content, not from the name.                                      |
| P6-3  | Attachments          | Expense receipts and supplier bills (D12 moves from references to files) and guest identity document scans (behind `guest.identity.read`, audited like reveals). Posted records keep their attachments; nothing is silently replaced.                                                                                                                                                 |
| P6-4  | Background jobs      | A Postgres-backed job queue (no Redis, per 02 §1 "Redis only where required"), every job carrying its verified tenant (05 §1). First uses: large exports (written to storage, link valid for a short time, audited) replacing the 50,000-row refusal, and clean-up of expired files.                                                                                                  |
| P6-5  | Environments         | Development, staging and production with separate credentials and databases (06 §4). Production images for the API and web built in CI; migrations run as a separate release step before the new version starts; configuration is validated at start-up (secure cookies, no debug, required secrets present).                                                                         |
| P6-6  | Release and rollback | Forward-only migrations, each reviewed; a backup is taken before every migration; rollback means the previous image plus, if a migration must be undone, restoring that backup into a new database (documented, drilled). Release notes per deploy. CI deploys to staging on merge to main, production on a tagged release with manual approval.                                      |
| P6-7  | Backups              | The provider's point-in-time recovery for the database (RPO target 15 minutes, PRD §9), plus a nightly encrypted logical backup to separate storage, kept 35 days and 12 monthly copies (retention to be confirmed by the accountant and legal adviser). Backup jobs are monitored; a failed backup alerts.                                                                           |
| P6-8  | Restore drill        | A script restores a backup into an isolated database and runs integrity checks: migrations at the expected version, every tenant's trial balance balanced, folio balances equal their ledger lines, cash accounts equal their ledger accounts, audit log intact, a test sign-in works. Results recorded with timings (RTO target 4 hours).                                            |
| P6-9  | Observability        | Structured logs exist (pino, request IDs, redaction). Add: metrics (latency, error rate, database connections, job failures, backup age, failed sign-in spikes), error tracking with guest data scrubbed, liveness and readiness endpoints, uptime checks, and alert rules with named destinations (05 §4).                                                                           |
| P6-10 | Load test            | k6 scripts against the 100-room dataset with many users at once: front desk, cashier and reporting mixes, plus bursts of simultaneous bookings and payments to prove no double booking or duplicate money under load (QA §5). Results and limits recorded.                                                                                                                            |
| P6-11 | Reviews              | Prompt D: threat-model-driven security review with automated cross-tenant and role probing of every route, upload abuse, brute force, headers, dependency audit; findings fixed or recorded. Prompt C: accounting review tracing each flow to its journals, packaged for your accountant to sign off. Prompt E: production-readiness report against the runbook and launch checklist. |

---

## Slices

### 6.1 Account recovery and sessions — PRD §8 "password recovery"

- **API:** change own password; owner/manager issue a staff password reset (one-time, expires, forces change at
  next sign-in, ends that user's sessions, audited, with a reason); list and end my other sessions; operators' own
  password change. Self-service email reset only if D18 says so (then an email provider and a signed, single-use,
  short-lived link). D18: manager-issued resets now; email self-service later.
- **Web:** "Change password" under My account; reset action on the staff screen; "Forgot password?" on sign-in
  explains the chosen route.
- **Tests:** old password required; reset link or temporary password works once and expires; sessions ended;
  rate limits; audit without secrets; tenant and role negatives.

### 6.2 File storage and attachments — SEC-003, D12

- **Infra:** MinIO in the local Docker setup; storage service with tenant-scoped keys; content-type and size checks.
- **API:** upload and download for expense attachments and guest identity scans; downloads return a signed link
  that expires (SEC-003); every download of an identity scan is audited.
- **Web:** attach on the expense form and guest profile; view or download.
- **Tests:** SEC-003 in full (no access without permission, link useless after expiry, no cross-tenant key
  guessing); unsafe files refused (wrong type, too large, renamed executables); keys never contain guest data.

### 6.3 Background jobs and large exports

- **API:** job queue in Postgres with tenant context and retries; export jobs above the on-screen limit write the
  file to storage and notify the user in the app; expired files removed by a scheduled job.
- **Tests:** a job never reads another tenant; retries do not duplicate files; the link expires; audit of each
  export kept.

### 6.4 Production builds, environments and the release pipeline

- **Repo:** Dockerfiles for API and web (non-root, minimal images), production configuration checks, security
  headers, and a provider-neutral production stack (D17 undecided): containers, reverse proxy with TLS, private
  database and storage, secrets from the environment; GitHub Actions builds and publishes the images and runs the
  release steps (backup, migrations, smoke tests) against any target; manual approval to production.
- **After D17:** templates for the chosen provider (managed database with point-in-time recovery, storage,
  container service, secret store, private network), as a short follow-up slice.
- **Yours:** choosing the provider (D17), cloud account, domain, DNS, secrets, GitHub environment approvals.
- **Tests:** images build and start locally with production settings; start-up refuses unsafe configuration; smoke
  test script passes against the local production stack.

### 6.5 Backups and restore drill — "a backup is not proven until restoration has been tested"

- **Repo:** backup job (encrypted logical dump to separate storage), retention policy, backup age metric; restore
  script and integrity checks (P6-8); drill runbook.
- **Executed here:** the full drill locally against a copy of the 100-room dataset, timed and recorded.
- **Yours:** the same drill in staging, then production, once provisioned (the runbook makes it a checklist).

### 6.6 Monitoring, alerting and incident response

- **Repo:** metrics endpoint, error tracking with scrubbing, readiness checks, alert rules (05 §4 list), dashboards
  as code; incident response runbook (severity, owner, containment, evidence, customer message, post-mortem).
- **Tests:** a failing dependency makes readiness fail; alerts fire in a local simulation (backup too old, error
  spike, failed sign-in spike); no guest identity data in error reports or metrics labels.

### 6.7 Load test — 100 rooms, many users

- **Repo:** k6 scenarios and a load-test runbook; results in `docs/phase-6-load-test.md`.
- **Executed here:** against the local production stack with the 100-room year; staging run is yours.
- **Pass:** p95 under 500 ms for common reads at the expected peak (QA §5); zero double bookings, zero duplicate
  payments or journals, trial balance balanced after the run.

### 6.8 Reviews and production readiness — Prompts D, C, E

- **Security review (D):** route-by-route automated probing for IDOR and role bypass, upload abuse, brute force,
  CSRF, headers, secrets in the repository and bundles, dependency audit; report with every finding fixed or
  explicitly accepted by you.
- **Accounting review (C):** each flow (room night, tax, deposit, payment, refund, write-off, transfer, expense,
  cash variance, night audit, month and year end) traced to its journals with the tests that prove it; questions
  for your accountant; their sign-off recorded.
- **Production readiness (E):** the launch checklist (05 §7) item by item with evidence, owner and date; pilot
  runbook (demo data removed, credentials rotated, opening balances reconciled, support contact named).

---

## Phase 6 exit gate (executed, not assumed)

Restore drill recorded with integrity checks passing (locally here; staging and production by you); no open
critical or high security findings; accountant sign-off on the accounting review; production-readiness checklist
complete or each open item owned and dated; load test passing; alerts verified to reach their destinations; SEC-003
complete; account recovery in place; all suites green in CI.

## Owner decisions (2026-10-21)

| #   | Question                                 | Decision                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D17 | Hosting provider and region (Phase 0 Q6) | **Undecided for now.** 6.4 builds provider-neutral images, stack, pipeline and runbooks; provider templates follow the choice (recommendation stands: a major cloud's nearest region with managed Postgres and point-in-time recovery, unless data must stay in Pakistan) |
| D18 | Password recovery route                  | **Manager-issued resets** at the pilot; email self-service later, with an email provider                                                                                                                                                                                  |
| D19 | Urdu at pilot (Phase 0 Q7)               | **English first**, Urdu after the pilot                                                                                                                                                                                                                                   |
| D20 | Data import for the pilot hotel          | **Manual set-up** with the existing onboarding and opening-balances wizard; no import slice                                                                                                                                                                               |

Also for qualified people, not decidable by me: backup and audit retention periods (accountant and legal adviser),
customer terms, privacy notice and data-processing terms (legal adviser), applicable tax and record-keeping
obligations before launch (05 §6), and the accountant's sign-off.

## Order

6.1 → 6.2 → 6.3 → 6.4 → 6.5 → 6.6 → 6.7 → 6.8, then the provider templates once D17 is chosen. Work continues on branch
`phase-1-foundation`.

## Notes from the build

- **6.1:** a manager-issued reset gives a temporary password of four groups of four characters (no look-alike
  letters, 80 random bits), shown once in the staff screen and kept nowhere else (not in the audit log, not in
  logs; checked by a test that captures the real log output). It works for 24 hours, ends every session of the
  person, and unlocks the account. Signing in with it leads to a new session state, `password_change`, reached
  only after any two-step verification; in it the API answers `PASSWORD_CHANGE_REQUIRED` to everything except
  choosing the new password, `me` and sign-out. Who may reset whom follows the existing staff rules: never
  yourself, never someone with more access than you. A wrong current password when changing your own counts
  toward the sign-in lockout. Users can see their sessions (device, since, last active) and end one or all
  others; operators change their own password in the console. The browser check found that finishing a sign-in
  step (two-step code, set-up, new password) could bounce back to the same step when the app had already cached
  the earlier session state; each step now refetches the session before moving on.
- **6.2:** MinIO no longer publishes container images (both registries refused the pull), so local storage is
  the Versity S3 Gateway (Apache 2.0, S3-compatible, checks request signatures), started by `pnpm db:up`. The
  API talks to any S3-compatible bucket through a small built-in client (Signature Version 4, path-style; checked
  against the AWS documentation's example), so the provider choice (D17) only changes four settings. Files are
  encrypted by the API before they leave (AES-256-GCM, key derived from `PII_ENCRYPTION_KEY`, tied to the
  attachment id), so the bucket on its own reveals nothing; rotating that key now also means re-encrypting files.
  Object keys are `t/<tenant>/p/<property>/<random id>` (`shared` for guest scans): never a file name or guest data.
  Downloads never go to the bucket directly: the API checks access, issues a link valid five minutes for that
  person and tenant only, re-checks the basic permission when it is used, and streams the file with no-store
  caching. Only PDF, JPEG and PNG are accepted, recognised from the content, at most 5 MB; PDFs that name
  scripts, launch actions or embedded files are refused (a first filter, not a virus scanner; a scanning service
  can be added once hosting is chosen). Receipts can be added to an expense at any stage except void, and removed
  only while it is a draft. Identity scans follow the identity-number rules: hidden without
  `guest.identity.read`, stored under a neutral name, a reason to open one, and the link and every download are
  audited. A removed file's row stays (who, when) while the stored file is deleted. Download links are replaced by
  `/files/[link]` in request logs. The same file sent twice to a record is kept once. Also fixed: the OpenAPI
  document had never listed path parameters (a regular expression typo); it now does.
- **6.3:** the job queue is a `jobs` table in Postgres. The worker runs inside each API instance (every
  `JOBS_POLL_SECONDS`, default 5; 0 turns it off) and claims work through one narrow `SECURITY DEFINER` function
  using `SKIP LOCKED` and a five-minute lease, so several instances can share it and a job whose instance stopped is
  picked up again. Each job carries the tenant it was created in, from the verified session, and runs inside that
  tenant's row-level security as the person who asked, with their access as it is when it runs (a permission
  removed in between fails the job with a reason). A refusal fails a job at once; anything else, including storage
  being down, is retried after 30 s, 60 s, … up to three tries. Exports over 50,000 rows are no longer refused:
  the export menu offers to prepare them in the background (up to 250,000 rows, at most three waiting per person),
  and "My exports" shows their progress and downloads them. The file is encrypted into private storage under the
  job's own key and recorded once per job, so a retry replaces it and never adds a second file or a second audit
  record. Only the person who asked can see the job or download the file (five-minute links, as for
  attachments), for 24 hours; a clean-up task deletes expired files every 15 minutes. The plan also named
  "clean-up of expired files" for attachments: attachments do not expire (removal deletes the file at once), so
  the only remaining case is an object whose delete failed; finding those needs a bucket listing and is left for
  the operations slice (6.6), where storage usage is monitored.
- **6.4:** see `docs/deployment-runbook.md`. Two images (API, web), both non-root; the API image also runs
  migrations. A provider-neutral Compose stack behind Caddy (automatic TLS, http→https, HSTS, `/api` routed to the
  API so cookies stay first-party), API and web read-only with all capabilities dropped. `release.sh` backs up,
  migrates, starts and waits for health; GitHub Actions publish images on every merge, deploy to staging, and to
  production on a version tag after approval, over SSH, then run `scripts/smoke.mjs`. Production start-up now
  refuses http origins, debug logging, placeholder keys, a short storage secret, the `postgres` user, and (once
  connected) any database role that row-level security does not bind. The web app sends a Content Security Policy
  and HSTS in production builds; it still allows inline scripts, which Next.js needs without nonces (a hardening
  item for 6.8). Storage over plain http is accepted only for a service on the private network. Found while
  building: CI's integration job had no object storage since 6.2, so the attachment tests could not have passed
  there; it now starts the same storage gateway. Proven locally twice (fresh, then re-release over it); also run by
  CI on every pull request. Not done here: anything needing D17 or your accounts (runbook, last section).
- **6.5:** see `docs/backup-and-restore.md`, which also holds the drill record. Nightly `pg_dump` with every
  table's row count taken in the same snapshot, encrypted per backup with a fresh key wrapped by an RSA public key
  (the backup job cannot read backups; the private key stays offline with you), stored in a separate bucket with
  35 daily and 12 monthly copies and a `latest.json` for the backup-age alert (6.6). `release.sh` now takes this
  encrypted backup before migrating instead of a plain dump on the host. The restore drill restores into a new
  database, runs seven integrity checks plus a real sign-in, and drops it; a test proves the checks catch an
  unbalanced line, a lost audit event and a mis-tagged cash line, and that a changed backup or the wrong key stops
  the drill. Drill on the 100-room year: passed in 18.5 s (target 4 h); the first run showed the folio check taking
  75 s, rewritten to under 1 s. The 100-room seed now also writes the folio charges and payments behind its
  journals, so the folio check holds on it. Locally there is no PostgreSQL client on this machine, so the tests
  run pg_dump inside the database container (`PG_TOOLS_CONTAINER`, local `.env` only); CI and the images use the
  tools directly. Not done here: the staging and production drills, the key pair and the backup bucket (yours).
- **6.6:** see `docs/incident-response.md`. `/health/live` (no dependencies) and `/health/ready` (database,
  storage, migrations; 503 `NOT_READY` names the failure; the image's health check uses it). Prometheus metrics on
  an internal port the proxy never routes to: request latency and status by route template, error codes (the
  failed sign-in spike), database pool, job queue, backup age and outcome (backups now record each attempt in
  `backup_runs`), readiness, memory. Labels are route templates and codes only; a test proves no guest id, name or
  identity number reaches them. Unexpected errors become one scrubbed report each (identity numbers, phones, emails,
  tokens removed; no request content), logged and optionally posted to `ERROR_WEBHOOK_URL`. Found while building:
  the query layer puts a failed statement's parameter values (names, phone numbers) into its error message, which
  the old error log copied; reports now drop that list entirely, checked by the log-capture test. 13 alert rules
  with promtool unit tests; Prometheus, Alertmanager and a Grafana dashboard as an optional `monitoring` profile.
  The local alert drill stops the API and waits for the alert, and its resolution, to reach a test receiver (also in
  CI). Readiness in production requires the storage bucket to exist; `node dist/ops/cli.js ensure-buckets`
  creates missing buckets at first set-up. Not done here: real alert destinations, owners and the legal answer on
  breach notification (yours, listed at the top of the runbook).
- **6.7:** see `docs/phase-6-load-test.md`. k6 (Docker) against the 100-room year: 20 front desk, 8 cashier and 4
  reporting users for three minutes, plus 30 simultaneous bookings of the last room and 20 simultaneous retries of
  one deposit. Common reads p95 232 ms (target 500 ms), writes p95 340 ms, reports p95 635 ms; no unexpected
  responses; one confirmed booking out of 30; one payment per idempotency key; gapless receipt numbers; ledger
  intact. The API ran in the test process (plain http, rate limits off for the single load generator); the
  production-stack run against staging is yours once D17 is decided. Found while building: the 100-room seed did not
  advance the journal counter (fixed); and running k6 synchronously froze the in-process API, so it now runs
  asynchronously.
- **6.8:** three reports: `docs/security-review.md` (Prompt D), `docs/accounting-review.md` (Prompt C) and
  `docs/production-readiness.md` (Prompt E). The playbook's prompt texts are clipped in the extracted copy of the
  PDF, so the reviews follow this plan's P6-11 scope. New automated evidence: a route probe over all 200 routes
  (unauthenticated, cross-tenant with real tenant A ids, role bypass, CSRF, platform), a secret scan of the
  repository and browser bundles, and a clean dependency audit; both run in CI. Fixed: a 500 when reading a stay
  after check-out (found by the probe); `drizzle-orm` (SQL injection advisory), PostCSS (build-time advisories) and
  Vitest (dev-only advisories) upgraded; GitHub Actions pinned to commits. Three low findings await your acceptance
  (inline scripts in the CSP, per-process rate limits, download links in browser history).
