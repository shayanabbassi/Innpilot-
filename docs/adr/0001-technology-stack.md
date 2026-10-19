# ADR-0001: Technology stack and architecture baseline

- Status: Accepted
- Date: 2026-10-19
- Deciders: Product owner (approved Phase 0 assessment)
- Context: `docs/phase-0-assessment.md`

## Decision

InnPilot is a TypeScript modular monolith in a pnpm + Turborepo monorepo.

| Concern                | Decision                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                    | NestJS 11, REST under `/api/v1`, OpenAPI generated from Zod contracts                                                                                             |
| Validation / contracts | Zod 3 schemas in `packages/contracts`, shared by API and web                                                                                                      |
| Database               | PostgreSQL 16; plain reviewed SQL migrations in `packages/db/migrations`; Drizzle ORM for typed queries                                                           |
| Money                  | `NUMERIC(19,4)` in DB, decimal strings in JSON, `decimal.js` behind `packages/money`. JS `number` never holds money                                               |
| Tenant isolation       | Session-derived tenant/property scope, PostgreSQL RLS (`app.tenant_id` set per transaction, app role cannot bypass RLS), composite `(tenant_id, id)` foreign keys |
| Auth                   | Server-side sessions (Postgres), HttpOnly cookie, Argon2id, TOTP MFA, Origin check + double-submit CSRF token                                                     |
| Authorization          | Global system roles → permission codes; deny-by-default guard; every route declares its policy                                                                    |
| Jobs                   | pg-boss + transactional outbox (introduced when first needed); no Redis in MVP                                                                                    |
| Web                    | Next.js 15 App Router, React 19, TanStack Query, React Hook Form, Tailwind CSS 4                                                                                  |
| Tests                  | Vitest (unit + integration against real Postgres), Supertest, Playwright                                                                                          |
| Local infra            | Docker Compose (Postgres 16; MinIO added with attachments)                                                                                                        |

## Phase plan change

The ledger core (chart of accounts, fiscal periods, journals, posting service, reversals) moves to the **start of
Phase 3**, so folio charges and payments post through it from the first day instead of being back-filled.

## Phase 1 implementation decisions

1. **One user belongs to one tenant** and email is globally unique (case-insensitive). This keeps login
   unambiguous for MVP. Users needing access to several tenants is deferred; platform administrators will use a
   separate identity table and login path (Phase 5).
2. **Roles are system-defined** (global `roles` / `role_permissions` tables seeded by migration). Tenants assign
   them but cannot create or edit them, which prevents tenant-level privilege escalation. Tenant-defined roles
   can be added later.
3. A role assignment with `property_id = NULL` applies to every property in the tenant.
4. **Pre-tenant lookups** (login by email, session resolution by token hash) go through two narrow
   `SECURITY DEFINER` functions. Every other query runs inside a transaction with `app.tenant_id` set.
5. **Password recovery by email is deferred** until an email provider is chosen (open decision). Phase 1 ships
   login, logout, session revocation and MFA.
6. Shared packages are compiled to CommonJS `dist/` and consumed by the API and web apps.

## Consequences

- Exclusion constraints, RLS policies, CHECKs and triggers are written by hand in SQL and reviewed; the Drizzle
  schema mirrors the tables for typed queries and must be kept in sync (checked by an integration test).
- The app's database role is not a table owner and has no `BYPASSRLS`, so a missing scope returns no rows
  instead of leaking data.
