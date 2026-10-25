# Threat model — Phase 1 foundation

Scope: authentication, sessions, tenant isolation, authorization, audit and the shared infrastructure every later
module builds on. Updated as each phase adds assets (folios and payments in Phase 3 add financial tampering and
duplicate-money threats in full).

## Assets

| Asset                                                           | Why it matters                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Tenant data (guests, staff, settings; later folios and ledgers) | Confidentiality between hotels; privacy obligations              |
| Sessions and credentials                                        | Account takeover gives the victim's permissions                  |
| Role assignments                                                | Control who can move money and change records                    |
| Audit log                                                       | Evidence for disputes, fraud investigation and accountant review |

## Actors

Anonymous internet users; staff of one hotel trying to reach another hotel's data; low-privilege staff trying to gain
privileges; a malicious or compromised owner/manager account; a developer mistake (missing scope or permission check).

## Threats and controls

| #   | Threat                                           | Controls in place                                                                                                                                                                                            | Verified by                                                         |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| T1  | Read or change another tenant's records (IDOR)   | Scope from session only; RLS on every tenant table; app DB role without BYPASSRLS; composite `(tenant_id, id)` FKs; strict request schemas reject `tenantId`; non-disclosing 404                             | `foundation.integration.test.ts`, `isolation.e2e.test.ts` (SEC-001) |
| T2  | A new table ships without RLS                    | Catalogue test fails if any table with `tenant_id` lacks RLS                                                                                                                                                 | `foundation.integration.test.ts`                                    |
| T3  | A new route ships without an authorization check | Deny-by-default guard; test fails if any route lacks a policy; public routes pinned to a list                                                                                                                | `route-policy.test.ts`                                              |
| T4  | Privilege escalation by staff admins             | Can only grant roles whose permissions they hold tenant-wide; cannot edit own access or anyone with more access; last-owner protection with row locks                                                        | `rbac.e2e.test.ts`                                                  |
| T5  | Property-scoped user acting on other properties  | Permissions computed per property; tenant-level actions need tenant-wide roles                                                                                                                               | `access.test.ts`, `rbac.e2e.test.ts`                                |
| T6  | Password guessing / credential stuffing          | Argon2id; constant-time-ish unknown-user path; 5-failure lockout for 15 min; 10/min per-IP login limit                                                                                                       | `auth.e2e.test.ts`, `app.smoke.test.ts`                             |
| T7  | Stolen password on a privileged account          | TOTP MFA required for owner, manager, accountant; applies immediately when a privileged role is granted; codes cannot be replayed                                                                            | `auth.e2e.test.ts`, `totp.test.ts`                                  |
| T8  | Session theft or fixation                        | 256-bit random tokens stored as SHA-256; new token per login; HttpOnly + SameSite=Lax + Secure (`__Host-` in production); idle (30 min) and absolute (12 h) expiry; revoked on logout, disable and MFA reset | `auth.e2e.test.ts`                                                  |
| T9  | Cross-site request forgery                       | CSRF token header compared to a hash stored with the session; Origin allow-list on state-changing requests                                                                                                   | `auth.e2e.test.ts`, `app.smoke.test.ts`                             |
| T10 | Duplicate financial effects from retries         | Idempotency keys inserted in the command's own transaction; concurrent duplicates execute once                                                                                                               | `idempotency.e2e.test.ts` (wired into payments in Phase 3)          |
| T11 | Tampering with audit history                     | Append-only trigger (UPDATE/DELETE/TRUNCATE) even for the owner role; app role has no DELETE                                                                                                                 | `foundation.integration.test.ts`                                    |
| T12 | Sensitive data in logs or error responses        | Log redaction for cookies, CSRF header, passwords, codes and secrets; query strings dropped from logs; generic 500s with request ID only                                                                     | `app.smoke.test.ts`                                                 |
| T13 | MFA secrets exposed in a database leak           | AES-256-GCM encryption with a key held outside the database                                                                                                                                                  | `totp.test.ts`                                                      |
| T14 | Clickjacking, MIME sniffing                      | Helmet headers on the API; `X-Frame-Options: DENY` and related headers on the web app                                                                                                                        | `app.smoke.test.ts`                                                 |

## Accepted risks and follow-ups

- **Account enumeration via lockout message.** After a lockout the response says the account is locked. Accepted so
  staff understand what happened; unknown emails never lock.
- **Global email uniqueness** reveals that an email is registered somewhere when an admin creates a user. Accepted for
  MVP (ADR-0001); revisit with multi-tenant user support.
- **In-memory rate limiting** resets on restart and is per instance. Move to a shared store before horizontal scaling.
- **No email-based recovery** yet (open decision on provider).
- **Support/platform-admin access** (built in slice 5.7): operators are a separate identity with their own session cookie and MFA at every sign-in; a tenant session never reaches platform routes and an operator session never reaches tenant routes (checked by a route test). Inside a tenant an operator sees only properties, staff accounts and recent activity, and only during a support grant that is reason-coded, at most four hours, and recorded in both the platform log and the tenant's own audit log. Guest and money records are never exposed to operators.
- **Production database owner**: locally the migrator is the Postgres superuser. Production must use a dedicated
  non-superuser owner role so SECURITY DEFINER functions run with least privilege.
