# Deployment runbook

Status: slice 6.4 (2026-10-22), single-server form slice 7.1 (2026-10-25). Everything here is provider-neutral: two
container images (amd64 and arm64), a Compose stack for any Linux host with Docker, and a GitHub Actions pipeline
that deploys over SSH. D17 (2026-10-25): staging runs on one Oracle Always Free machine with Cloudflare R2, set up by
following [staging-runbook.md](staging-runbook.md); production waits for D21 (a managed database with point-in-time
recovery).

Sources: 05 Security & Deployment Runbook §1–7, 02 Technical Architecture §7–10, 06 Test Strategy §4, Phase 6
plan P6-5 and P6-6.

## What is in the repository

| Piece                                         | What it does                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/Dockerfile`                         | API image: Node 24 on Alpine, production dependencies only, no source or `.env`, runs as the unprivileged `node` user, health check on `/api/v1/health`. The same image runs migrations (`node node_modules/@innpilot/db/dist/cli.js migrate`). |
| `apps/web/Dockerfile`                         | Web image: Next.js standalone server, runs as `node`.                                                                                                                                                                                           |
| `deploy/compose.yml`                          | The production stack: Caddy (TLS certificates and renewal, http→https, HSTS), API, web; release-only services for the pre-migration backup and migrations. API and web run read-only, with all Linux capabilities dropped.                      |
| `deploy/caddy/`                               | One public origin: `/api/*` to the API, the rest to the web app, so cookies stay first-party. No access log (URLs can hold download links and search terms; the API logs requests itself, with those removed).                                  |
| `deploy/env.example`                          | Every production setting, split into `app.env` (the API) and `release.env` (database owner, release steps only).                                                                                                                                |
| `deploy/release.sh`                           | One release: pull images, encrypted backup of the database, migrate, start, wait for health.                                                                                                                                                    |
| `scripts/smoke.mjs`                           | Smoke test after every release: health, security headers, unauthenticated and cross-site requests refused, error envelope, optional sign-in round trip with a smoke-test account.                                                               |
| `deploy/compose.single.yml`, `deploy/single/` | Single-server form (P7-1, staging): PostgreSQL on the same machine; the server set-up script and the settings generator. Steps: docs/staging-runbook.md.                                                                                        |
| `deploy/compose.local.yml`, `deploy/local/`   | The single-server stack on a laptop or CI runner, with its own storage, on `https://localhost:8443`.                                                                                                                                            |
| `.github/workflows/ci.yml`                    | Every pull request: format, lint, types, unit, build, dependency audit; database and end-to-end tests (Postgres and storage); production images started and smoke-tested.                                                                       |
| `.github/workflows/release.yml`, `deploy.yml` | Merge to `main`: images published to GitHub Container Registry, deployed to staging. Tag `v*`: the same images deployed to production after approval.                                                                                           |

## Monitoring

The API serves `/api/v1/health/live` (process up), `/api/v1/health/ready` (database, storage, migrations; use
this for the provider's uptime check and TLS expiry check) and Prometheus metrics on the internal port 9464. Start
the `monitoring` profile (`docker compose --profile monitoring up -d`) for Prometheus with the alert rules,
Alertmanager with your destinations and Grafana with the dashboard, or point a managed equivalent at the same
endpoints. Alerts, owners and what to do: docs/incident-response.md.

## Start-up refuses unsafe configuration

In production (`NODE_ENV=production`, set by the images) the API will not start, and lists every problem, if:
cookies are not Secure; rate limiting is off; any web origin is not https; logging is at debug or trace; storage is
reached over plain http outside the private network; the storage secret is short; an encryption key looks like a
placeholder; or the database URL uses the `postgres` superuser. Once connected it also refuses a database role that
row-level security does not bind (superuser, `BYPASSRLS`, or owner of the tables), because that would switch off
tenant isolation silently.

## First-time set-up (yours)

1. **Provider (D17).** A Linux host (or container service) with Docker, a managed Postgres 16 with point-in-time
   recovery and TLS, a private S3-compatible bucket, all in one region and private network.
2. **Domain and DNS.** Point the host name (e.g. `app.<your-domain>`) at the host; Caddy obtains the certificate.
3. **Database.** Create the `innpilot` database and an owner account. Put the owner URL and a new random
   `APP_DB_PASSWORD` in `release.env`. Then, once, create the restricted application role, and use the same
   password in `app.env`'s `DATABASE_URL`:
   `docker compose --profile release run --rm migrate node node_modules/@innpilot/db/dist/cli.js provision`.
   The first `release.sh` applies the migrations.
4. **Secrets.** Fill `app.env` from `deploy/env.example` with fresh random keys. Keep a sealed offline copy of
   `MFA_ENCRYPTION_KEY` and `PII_ENCRYPTION_KEY`: losing them makes enrolled two-step codes, identity numbers and
   stored files unreadable. Separate values for staging and production; never copy production data to staging.
5. **Registry access.** On the host, `docker login ghcr.io` once with a read-only token for the images.
6. **GitHub.** Repository variables `STAGING_HOST`, `PRODUCTION_HOST`; environments `staging` and `production`
   with variables `DEPLOY_USER`, `DEPLOY_DIR`, `SITE_ADDRESS` and secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`
   (the host key, checked out of band), optionally `SMOKE_EMAIL`/`SMOKE_PASSWORD`; **required reviewers on
   `production`**.
7. **First hotel.** `tenant:create` through the image (D20: the owner then sets up through the onboarding wizard).

## Each release

Automatic once set up: merge to `main` releases to staging; tag `vX.Y.Z` releases to production after approval.
By hand on the host: `API_IMAGE=… WEB_IMAGE=… SITE_ADDRESS=… sh release.sh`, then `node scripts/smoke.mjs
https://<host>`. Write release notes per deployment (what changed, migrations included, anything to watch).

**Migrations** are forward-only and reviewed with the code. Each release takes an encrypted backup to the separate
backup bucket first (docs/backup-and-restore.md).
Migrations must stay compatible with the version still running while they apply (add before you remove).

## Rollback

- **Code only:** run `release.sh` with the previous image tags. Migrations already applied stay, which is why they
  must remain compatible with the previous version.
- **A migration must be undone:** do not edit the database by hand. Restore the pre-migration backup into a
  **new** database with the restore drill (`--keep`), which runs the integrity checks, point `DATABASE_URL` at it,
  and release the previous images (docs/backup-and-restore.md). Anything written after the backup must be re-entered; record the incident.

## Proven here, still to do there

Proven locally (and in CI on every pull request): both images build and start with production settings, unsafe
settings are refused, the restricted database role is enforced, provisioning, backup-before-migrate and all 25
migrations run through the release script, the stack serves over TLS behind Caddy with its security headers, and
the smoke test passes including a sign-in round trip with `__Host-`, Secure, HttpOnly cookies.

Not yet done (needs D17 and your accounts): staging and production hosts, DNS and public certificates, managed
database TLS (`sslmode=verify-full`), registry and SSH secrets, the first real deployment and its smoke test,
pinning third-party GitHub Actions to commit hashes (security review, 6.8).
