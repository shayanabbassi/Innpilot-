# InnPilot — Phase 0 Assessment & Architecture Proposal

Status: **Approved 2026-10-19** (stack as proposed; Docker Desktop for local DB; ledger core moved to start of Phase 3) — see docs/adr/0001-technology-stack.md · Date: 2026-10-19 · Playbook step: Prompt A (repository assessment)

No code is written until this document is approved. After approval, the stack and decisions below are frozen as
ADR-0001 and only change through a new ADR.

---

## 1. Repository state

| Item                         | Finding                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source code                  | None. Folder contains only the 19 specification PDFs. Not a git repository.                                                                          |
| Existing stack / conventions | None to inherit — greenfield.                                                                                                                        |
| Machine tooling              | Node.js 24.19, npm 11.17, git 2.55. **Not installed:** pnpm, Docker, PostgreSQL.                                                                     |
| Spec pack                    | Original concept pack (00 PRD … 07 Handoff) + v1.0 supplement (00 Decisions Delta … 09 Index). Supplement supersedes the original where they differ. |

Note: Prompts A–E in `07_Claude_Implementation_Playbook_and_Prompts.pdf` are truncated inside the PDF itself (each
cuts off mid-sentence). Prompt A was interpreted as: read all requirements, report stack/architecture, existing
state, conflicts, gaps and a phase plan. Please supply the full prompt text if it asked for more.

## 2. System summary (in my own words)

A multi-tenant SaaS for independent Pakistani hotels (10–100 rooms, one property per tenant initially, schema ready
for groups). It runs front-desk operations — rooms, reservations, walk-ins, check-in/out, housekeeping — and a
**real double-entry ledger** underneath: folios are subledgers, payments/refunds/expenses are source documents, and
a server-side posting service turns them into immutable, balanced journals. Daily close (night audit) posts nightly
room charges exactly once per business date, checks cashier sessions and unresolved balances, and advances the
business date. Owners get dashboards and statements (TB, P&L, balance sheet, cashbook, aging) that must reconcile
to the ledger. Release-critical properties: tenant isolation, ledger integrity, idempotency, auditability, restorable
backups. Responsive web only, PKR / Asia/Karachi defaults, all tax rules configurable and effective-dated.

## 3. Proposed technology stack

The spec's suggested stack (Next.js + NestJS + PostgreSQL) is sound and I recommend keeping it, with these
specific choices:

| Concern          | Choice                                                                                                                                                      | Why                                                                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language         | TypeScript (strict) end to end                                                                                                                              | One language for API, UI and shared money/validation code.                                                                                                                                                                                                                      |
| Monorepo         | pnpm workspaces + Turborepo                                                                                                                                 | Shared packages (money, schemas, API client) without publishing.                                                                                                                                                                                                                |
| API              | **NestJS** (modular monolith), REST `/api/v1`, OpenAPI 3.1 generated from code                                                                              | Spec-recommended; modules map 1:1 to the domain boundaries in 02_Technical_Architecture.                                                                                                                                                                                        |
| Validation       | **Zod** schemas in a shared package, used by API (nestjs-zod) and forms                                                                                     | One source of truth for request shapes; OpenAPI generated from them.                                                                                                                                                                                                            |
| Database         | **PostgreSQL 16**                                                                                                                                           | Exclusion constraints (`daterange` + GiST) for booking overlap, RLS, NUMERIC, transactional DDL.                                                                                                                                                                                |
| Data access      | **Drizzle ORM** + SQL migrations (drizzle-kit, hand-reviewed)                                                                                               | Typed queries but close to SQL; exclusion constraints, RLS policies, CHECKs and triggers live in plain reviewed migration SQL. Prisma was rejected because these features need raw-SQL workarounds and its interactive transactions are awkward for `SET LOCAL` tenant context. |
| Money            | `NUMERIC(19,4)` in DB, **decimal strings** in JSON, `decimal.js` in TS behind a `Money` type                                                                | Resolves the spec's "NUMERIC or minor units" choice in favour of the supplement's NUMERIC(19,4). No `number` ever holds money.                                                                                                                                                  |
| Tenant isolation | Scoped repositories (tenant/property from session) **+ PostgreSQL RLS** via `SET LOCAL app.tenant_id` per transaction **+ composite FKs** `(tenant_id, id)` | Three independent layers; the app DB role is not table owner and cannot bypass RLS.                                                                                                                                                                                             |
| Auth             | Server-side sessions in Postgres, HttpOnly/Secure/SameSite=Lax cookie, **Argon2id**, TOTP MFA, CSRF via Origin check + double-submit token                  | Cookie sessions are revocable instantly (spec requirement) and avoid token-in-JS risk. Web and API served same-site behind one reverse proxy.                                                                                                                                   |
| Authorization    | Permission strings (`payment.refund`, `journal.post`…) on roles; deny-by-default guard on every route + resource-level property check                       | Matches 05_Security permission examples.                                                                                                                                                                                                                                        |
| Background jobs  | **pg-boss** (Postgres-backed queue) + transactional outbox                                                                                                  | No Redis in MVP — one fewer service to run and back up; jobs commit atomically with business data. Redis can be added later if load proves the need.                                                                                                                            |
| Attachments      | S3-compatible private bucket, short-lived signed URLs (MinIO locally)                                                                                       | Provider-neutral.                                                                                                                                                                                                                                                               |
| Frontend         | **Next.js (App Router)** + React + TanStack Query + React Hook Form + Zod                                                                                   | Spec-recommended; UI talks only to the REST API (no business logic in Next server actions).                                                                                                                                                                                     |
| UI kit           | Tailwind CSS + shadcn/ui (Radix primitives), design tokens from 04_Frontend (§5)                                                                            | Accessible primitives, owned component code, easy to theme navy/teal.                                                                                                                                                                                                           |
| i18n             | next-intl wired from day one (English strings only at first)                                                                                                | Keeps Urdu/RTL possible later without rewriting every screen.                                                                                                                                                                                                                   |
| Testing          | Vitest (unit), Vitest + real Postgres (integration/concurrency/isolation), Supertest (API), Playwright (E2E, 360/768/1280 viewports)                        | Ledger and isolation tests must run against real Postgres, not mocks.                                                                                                                                                                                                           |
| Quality gates    | ESLint, Prettier, `tsc --noEmit`, dependency audit, GitHub Actions CI                                                                                       | Established in Phase 1 before any feature work.                                                                                                                                                                                                                                 |
| Observability    | pino structured logs with request IDs + redaction, OpenTelemetry hooks, Sentry-compatible error tracking                                                    | Redaction list for IDs/tokens/passwords set up in Phase 1.                                                                                                                                                                                                                      |
| Packaging        | Docker images for api, web, worker; docker-compose for local Postgres + MinIO                                                                               | Hosting-provider neutral until the region decision is made.                                                                                                                                                                                                                     |

## 4. Proposed repository layout

```
innpilot/
  apps/
    api/            NestJS — modules: identity, tenancy, rbac, audit, rooms, reservations, guests, stays,
                    folios, payments, ledger, cash, expenses, housekeeping, night-audit, reports, platform-admin
    web/            Next.js — app shell, feature routes, design system usage
    worker/         pg-boss consumers (outbox dispatch, exports, scheduled reports)
  packages/
    money/          Money type, rounding, allocation helpers (+ exhaustive unit tests)
    contracts/      Zod schemas, error codes, permission names, enums shared by api/web
    api-client/     Typed client generated from OpenAPI
    ui/             Shared React components (AppShell, DataTable, MoneyField, StatusBadge…)
    db/             Drizzle schema, migrations (001…007 per DB plan), seed scripts (fictional data only)
  docs/
    adr/            Architecture decision records
    openapi/        Generated contract (checked in, diffed in CI)
  .github/workflows/
  docker-compose.yml   Postgres 16 + MinIO for local dev
  .env.example         Variable names only, no values
```

## 5. Phase plan

Your requested order, mapped onto the playbook's phases and migration sequence. Each slice ships migration + API +
UI states + permissions + audit + tests. Tests and the P0 matrix run continuously from Phase 1, not only at the end.

| #   | Phase                            | Contents                                                                                                                                                                                                                                                      | Exit gate (must pass, executed)                                              |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0   | Plan                             | This document, threat model, ADR-0001                                                                                                                                                                                                                         | Owner approves stack + assumptions                                           |
| 1   | **Tenant & security foundation** | Monorepo, CI, Postgres + RLS, tenants/properties/users, sessions, Argon2id, MFA, RBAC, audit events, idempotency table, error envelope, app shell + login (migration 001)                                                                                     | SEC-001/002 cross-tenant & role-bypass negative tests pass; CI green         |
| 2   | **Hotel operations**             | Property setup/onboarding, room types, rooms, rates, guests, reservations with exclusion constraint, room board, check-in/out, housekeeping tasks & room status (migrations 002, part of 006)                                                                 | OPS-001 concurrent booking, OPS-002, OPS-003, state-transition tests pass    |
| 3   | **Folios & payments**            | Folios, charges, effective-dated tax codes + snapshots, payments, allocations, receipts, refunds, invoices (migration 003)                                                                                                                                    | FIN-003, FIN-008, TAX-001, folio reconciliation recipe pass                  |
| 4   | **Accounting**                   | COA template, fiscal periods, posting service, journals/reversals, cash accounts, cashier sessions, expenses/vendors/payables, reconciliation, night audit + business-date close (migrations 004, 005, rest of 006). Phases 2–3 are wired to post through it. | FIN-001…007, CASH-001, OPS-004 (night audit idempotent) pass                 |
| 5   | **Reporting**                    | Dashboard KPIs, TB, P&L, balance sheet, cashbook, guest/payables aging, tax summary, exports, user admin, audit log viewer, super-admin & subscriptions (migration 007)                                                                                       | Financial statements reconcile to fixtures; report permission tests; AUD-001 |
| 6   | **Deployment & testing**         | Hosting, backups + restore drill, monitoring/alerts, load test on 100-room dataset, security review (Prompt D), accounting review (Prompt C), production readiness (Prompt E)                                                                                 | Restore test recorded; no open critical/high defects; accountant sign-off    |

Sequencing note: in Phase 3, folio charges and payments are recorded as source documents with posting status
`pending`; Phase 4's posting service then posts them. Alternatively the ledger core (accounts, journals, posting
service) can move to the start of Phase 3 so folios post from day one — **I recommend this** to avoid back-filling.

## 6. Conflicts found between documents

These are resolved by my default below unless you say otherwise.

| #   | Conflict                                                                                  | Sources                            | Proposed resolution                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | RPO/RTO: 15 min / 4 h vs 24 h / 8 h                                                       | PRD §12 & Arch §9 vs Runbook §4    | Runbook (later doc) as launch minimum; PITR-capable managed Postgres so 15 min is achievable.                                                                                                  |
| C2  | Money as NUMERIC **or** integer minor units                                               | DB Dictionary, API Spec vs DB Plan | NUMERIC(19,4) + decimal strings in JSON.                                                                                                                                                       |
| C3  | Role names differ (receptionist/GM/auditor vs front_desk/hotel_manager/read_only_auditor) | PRD §3 vs Runbook §2               | Use runbook identifiers; PRD names as display labels.                                                                                                                                          |
| C4  | Night audit, payables, full statements are Phase 2 in PRD but P0 in supplement            | PRD §5 vs Decisions Delta, Backlog | Supplement wins: all in MVP.                                                                                                                                                                   |
| C5  | Room status vocabularies differ                                                           | PRD §6.8 vs Frontend §4            | Model three separate fields: occupancy (derived from stays), housekeeping state (dirty/cleaning/clean/inspected), service state (in service/out of order). Board labels are derived from them. |
| C6  | Super-admin/subscriptions: MVP in PRD, P1 in backlog, absent from your phase list         | PRD §5, Backlog                    | Placed in Phase 5 (minimal: tenant status + plan; no billing provider).                                                                                                                        |
| C7  | Booking date semantics undefined                                                          | Arch §4 requires them defined      | Half-open `[arrival, departure)` on business dates; a room can be departed and arrived on the same date.                                                                                       |

## 7. Risky assumptions I will make unless told otherwise

- Online-only (no offline mode). Front desk needs internet.
- English UI first; i18n plumbing present for later Urdu.
- PKR only for postings in MVP (currency column kept on every amount).
- Room revenue recognised nightly by night audit; guest deposits held as liability until applied (spec §4 default).
- Taxes configured per property by the hotel; no rates shipped as constants, a blank tax setup is valid.
- Invoice numbering: per-property, gapless sequence per series, assigned at issue time.
- No payment gateway, OTA, SMS/WhatsApp or FBR/PRA/SRB integrations in MVP.

## 8. Questions for you (high-impact only)

**Needed before Phase 1:**

1. **Stack approval** — approve §3 as-is, or name changes.
2. **Local database** — Docker isn't installed. Install Docker Desktop (recommended: also runs MinIO and the test
   database), or install PostgreSQL 16 natively?
3. **Ledger timing** — move the ledger core to the start of Phase 3 (recommended, §5 note), or keep strict order?

**Needed before Phase 3 (can answer later):** 4. **Rounding** — PKR totals on invoices rounded to 2 decimals (paisa) or whole rupees? 5. **Tax-inclusive or exclusive** room rates as the default for new properties?

**Needed before Phase 6:** 6. **Hosting region / data residency** — any requirement that data stay in Pakistan, or is a nearby region
(e.g. Middle East / Mumbai) acceptable? 7. **Urdu** — required at pilot launch, or later?

**Require a qualified human (not decidable by me):**

- Deposit and revenue-recognition policy, tax recoverability, and the chart-of-accounts template → Pakistan-based accountant.
- Applicable federal/provincial sales tax on services, invoice fields, guest-registration and record-retention
  obligations → local tax/legal adviser.

## 9. Threat model summary (expanded into docs/threat-model.md in Phase 1)

| Threat                             | Primary controls                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cross-tenant data access (IDOR)    | Session-derived scope, RLS, composite FKs, non-disclosing 404, negative tests on every list/read/write/export    |
| Privilege escalation               | Deny-by-default permission guard, resource-level property check, role changes audited, MFA for privileged roles  |
| Financial tampering / silent edits | Immutable posted journals (DB trigger blocks UPDATE/DELETE), reversals only, period locks, audit log append-only |
| Duplicate money movement           | Idempotency keys stored with response, unique constraints, night-audit run unique per business date              |
| Double-booking                     | `EXCLUDE USING gist (room_id WITH =, stay_range WITH &&)` + concurrency tests                                    |
| Credential attacks                 | Argon2id, rate limiting, lockout/backoff, short-lived reset tokens, session revocation                           |
| Sensitive data leakage             | Log redaction, encrypted ID document numbers, private object storage, signed URLs, role-restricted fields        |
| Support-staff abuse                | Time-bound, reason-coded, audited support access                                                                 |
| Data loss                          | PITR backups, encrypted, restore drills recorded                                                                 |
