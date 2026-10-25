# InnPilot

Hotel operations and finance SaaS for independent hotels in Pakistan (10–100 rooms). Multi-tenant, responsive web,
double-entry accounting underneath front-desk operations.

> **Status: Phase 1 (tenant & security foundation).** Not production-ready. Specifications are in the PDF pack in
> this folder (kept out of git). Architecture decisions: [docs/adr](docs/adr). Plan: [docs/phase-0-assessment.md](docs/phase-0-assessment.md).

## Repository layout

| Path                        | What                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api`                  | NestJS REST API (`/api/v1`): auth, sessions, MFA, RBAC, properties, staff, audit log              |
| `apps/web`                  | Next.js web app: sign-in, two-step verification, app shell, staff, audit log, property settings   |
| `packages/contracts`        | Zod request/response schemas, permission catalogue and roles, error codes — shared by API and web |
| `packages/db`               | SQL migrations, Drizzle schema mirror, tenant-scoped transactions, migrator, seed                 |
| `packages/money`            | Decimal-safe `Money` type (never floating point)                                                  |
| `docs/openapi/openapi.json` | Generated API contract (a test fails if it is stale)                                              |

## Prerequisites

- Node.js 24 (`.nvmrc`) and pnpm 10 (`npm install -g pnpm@10.34.7`)
- Docker Desktop (runs PostgreSQL 16 and the object storage gateway locally)

## First-time setup

```bash
pnpm install
```

Copy `.env.example` to `.env` and fill in every empty value. Generate random secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then start the database and object storage, create the restricted application role, migrate and load fictional
demo data:

```bash
pnpm db:up
```

```bash
pnpm db:provision
```

```bash
pnpm db:migrate
```

```bash
pnpm db:seed
```

## Running

```bash
pnpm dev
```

Web: http://localhost:3000 · API: http://localhost:4000/api/v1/health

Demo accounts (all use `SEED_USER_PASSWORD` from your `.env`) are listed in
[packages/db/src/seed.ts](packages/db/src/seed.ts), for example `owner@ravi.demo.test` (owner, will be asked to set
up two-step verification) and `frontdesk@ravi.demo.test`. A second tenant (`*@kohsar.demo.test`) exists so you can
see that tenants are isolated.

## Production-like stack and deployment

The production images, start-up checks, release script and smoke test can be run locally on
https://localhost:8443 (also run by CI on every pull request):

```bash
node deploy/local/init.mjs
```

```bash
node deploy/local/up.mjs
```

Deploying to staging and production: [docs/deployment-runbook.md](docs/deployment-runbook.md).

## Adding a hotel (tenant)

Hotels are created by an InnPilot operator, not by public sign-up. This creates the tenant, its first property and
a tenant-wide owner, and asks for the owner's password without echoing it:

```bash
pnpm tenant:create --slug margalla --legal-name "Margalla Hotels (Pvt) Ltd" --display-name "Margalla Hotel" --property "Margalla Hotel" --owner-email owner@example.com --owner-name "Owner Name"
```

On first sign-in the owner sets up two-step verification and then the setup wizard (business details, location
and times, review). Other staff see a "setup in progress" notice until it is finished.

## Checks

| Command                                              | Runs                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Static checks                                                                                             |
| `pnpm test`                                          | Unit tests and API boot smoke tests (no database needed)                                                  |
| `pnpm test:integration`                              | Database tests: RLS, composite keys, auth, MFA, cross-tenant and role tests, idempotency (needs Postgres) |
| `pnpm build`                                         | Production builds                                                                                         |
| `pnpm --filter @innpilot/api openapi`                | Regenerate `docs/openapi/openapi.json` after changing routes or contracts                                 |

## Security model (summary)

- Tenant and property scope come only from the server-side session. Every tenant-owned table has PostgreSQL
  row-level security, and the API's database role cannot bypass it.
- Child rows reference parents by `(tenant_id, id)`, so cross-tenant references are impossible at the database level.
- Every route declares an access policy; a test fails if one is missing. Permissions are checked server-side.
- Sessions: random tokens stored hashed, HttpOnly cookies, CSRF token header plus Origin check, idle and absolute expiry,
  revocation on logout, disable and MFA reset.
- Argon2id passwords, account lockout, per-IP rate limits, TOTP MFA required for owner, manager and accountant roles.
- The audit log is append-only (database trigger) and records actor, request ID and before/after values.

See [docs/threat-model.md](docs/threat-model.md).

## Known limitations (Phase 1)

- Password recovery by email is not built (needs an email provider decision). Owners and managers set initial
  passwords; lost authenticators are reset by an owner.
- Tenants are created by the seed script; self-service onboarding arrives in Phase 2.
- Rate limits are per API instance (in memory). A shared store is needed before running more than one instance.
- English only; Urdu is prepared for (strings in `apps/web/messages`) but not translated.
