# Phase 7 — Pilot: slice plan

Status: **Planned; slice 7.1 in progress** · Builds on: Phase 6 (accepted 2026-10-23), first GitHub CI run green and
pull request #1 merged (c161a08, 2026-10-25)

Scope: taking the finished product to one pilot hotel. Hosting (D17), staging brought up and drilled, production
prepared, the hotel set up and trained, and the first weeks of real use. Sources: the pilot runbook and launch
checklist in [production-readiness.md](production-readiness.md), 05 Security & Deployment Runbook §3–7, PRD §9
(launch criteria), and the open items of the [Phase 6 exit report](phase-6-exit-report.md).

**What I can and cannot do.** I build and test everything that lives in this repository: templates, scripts, the
pipeline, runbooks, and fixes for what the pilot finds. I cannot create the Oracle, Cloudflare or GitHub settings,
hold the secrets, or speak to the hotel, the accountant or the legal adviser; each slice lists those steps as yours,
written so you can follow them one by one.

---

## Owner decisions

| #   | Topic                | Decision                                                                                                                                                                                                                                            |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D17 | Hosting (2026-10-25) | **Staging:** Oracle Cloud Always Free (one Ampere A1 Arm virtual machine) with Cloudflare R2 for files and backups, at no cost. **Production:** a small paid server later; provider chosen before the pilot's first real day (D21)                  |
| D21 | Production provider  | Open. Must meet PRD §9 (RPO 15 minutes, RTO 4 hours), which a single free server cannot: needs a managed database with point-in-time recovery, or archived write-ahead logs                                                                         |
| D17 | Revised (2026-10-25) | No payment card yet, so Oracle and R2 cannot be opened. **Staging now runs on your own computer** with Tailscale Funnel for the public https address (home staging). The Oracle + R2 templates stay ready for when a card is available              |
| D22 | Selling model        | **On-premises first:** InnPilot is sold and installed on each buyer's own PC (one hotel per install); a cloud service follows after growth. Home staging is the template for that install; what selling on-premises still needs is listed under 7.3 |

## Design decisions (defaults unless you say otherwise)

| #    | Topic                   | Decision                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P7-1 | Single-server stack     | One machine runs the proxy, web, API, PostgreSQL (in a container, on a volume, never published), the backup scheduler and, optionally, monitoring. `deploy/compose.single.yml` adds the database to the provider-neutral `compose.yml`; the local production-like stack builds on it, so CI proves the single-server form on every pull request                   |
| P7-2 | Arm images              | Release builds every image for amd64 and arm64, each natively on GitHub's runners (free for public repositories), and publishes one multi-platform tag                                                                                                                                                                                                            |
| P7-3 | Storage on R2           | Two buckets, application files and backups, each with its own API token limited to that bucket; region `auto`; buckets made in the Cloudflare dashboard, never by the application                                                                                                                                                                                 |
| P7-4 | Address and TLS         | A free subdomain (for example DuckDNS) or your own domain; Caddy obtains and renews the certificate itself                                                                                                                                                                                                                                                        |
| P7-5 | Staging recovery limits | No point-in-time recovery on one server: staging loses at most a day (nightly encrypted backup to R2). Accepted for staging only, never for production (D21)                                                                                                                                                                                                      |
| P7-6 | Idle reclamation        | Oracle may reclaim an Always Free machine that stays under 20% CPU, network and memory for a week. No artificial load (that would work around Oracle's policy). Instead: switch the account to pay-as-you-go (Oracle's 2023 notice exempts paid accounts; usage within Always Free limits stays free), and a rebuild from backup that is written down and drilled |
| P7-7 | Secrets                 | Generated on the server by a script, readable only by the deploy user; never in git, chat or CI logs. GitHub holds only the deploy SSH key and the host's verified key                                                                                                                                                                                            |
| P7-8 | Staging data            | Fictional only, as everywhere outside production. Staging also serves as the training copy (pilot runbook step 7)                                                                                                                                                                                                                                                 |

---

## Slices

### 7.1 Single-server templates — D17, P7-1 to P7-4, P7-7

- **Stack:** `deploy/compose.single.yml` (PostgreSQL 16 container, the role provisioning service, release services
  waiting for the database); `compose.local.yml` rebased on it.
- **Images:** release workflow builds amd64 and arm64 natively and merges them under one tag.
- **Deploy:** the deploy workflow copies the stack files the environment needs and passes its compose files
  (`COMPOSE_FILES` variable), so staging uses the single-server form and production the managed one.
- **Server:** `deploy/single/setup-server.sh` for Ubuntu 24.04 (Arm or x86): Docker from Docker's own repository,
  firewall opened for 22, 80 and 443 only (including Oracle's image rules), log rotation, automatic security
  updates, a deploy user. `deploy/single/init-env.sh` writes the settings files with fresh random secrets and
  placeholders for the R2 keys and the address.
- **Runbook:** `docs/staging-runbook.md`, step by step from account sign-up to first release, written for you.
- **Home staging (D17 revised):** `deploy/compose.home.yml` (storage on the same computer, proxy on
  `127.0.0.1:8090` behind Tailscale Funnel, its own Compose project), `deploy/caddy/Caddyfile.home`,
  `deploy/home/release.mjs` (build or pull, the same `release.sh`, smoke-test hotel, smoke test), settings from
  `deploy/local/init.mjs --dir deploy/home`; `docs/home-staging-runbook.md`.
- **Tests:** the local production-like stack (images, provisioning, release, smoke test, restore drill, alert drill)
  runs on the single-server form locally and in CI; both architectures build in the release workflow.

### 7.2 Staging up and drilled — pilot runbook step 1

- **Done:** home staging live at `https://inpilot.tail96c7fc.ts.net` (2026-10-25), smoke test 6/6 over the public
  address; settings saved off the computer (USB and an encrypted copy in Google Drive), backup key removed from it.
- **On home staging, in this order:**
  1. **Visitor addresses:** Caddy keeps the address Tailscale forwards and the API trusts two proxies; a forged
     address is ignored. Done; finding: Funnel forwards its own address, so visitors still share one (runbook).
  2. **Your own hotel account** on staging (a fictional training hotel, you as owner, two-step verification on
     your phone), to look around and to train staff later.
  3. **Restore drill (passed 2026-10-29, after the missed-backup fix)** on staging, with the backup key brought back for the run only.
  4. **Rebuild drill (passed 2026-10-29, 58 s):** the whole staging rebuilt from the latest backup and the saved settings into a fresh Docker
     project, as after a lost or broken computer (P7-6); exact commands written into the runbook.
  5. **Backups off the computer:** a scheduled copy of the encrypted backups to a folder that leaves the machine
     (Google Drive for desktop or a USB drive): needed for staging's safety and for every on-premises sale (D22).
  6. **Alerts to your phone:** the monitoring profile with a free destination (a Telegram bot or email), proved with
     a test alert.
  7. Route probe and a light load run against staging, recorded.
- **Later, with a card:** the same on Oracle and R2 (staging-runbook.md).

### 7.3 Production and pilot preparation — pilot runbook steps 2 to 7

- D21 production provider and its template (managed database with point-in-time recovery, storage, the deploy
  environment with manual approval).
- Launch checklist owners and dates; accountant sign-off on the accounting review and the tax set-up; legal review
  of terms, privacy notice and retention; F-7, F-8 and F-9 decided.
- The pilot hotel created, set up through onboarding, opening balances agreed with the accountant; staff trained on
  staging.
- **On-premises install (D22), not built yet:** a one-command installer for a buyer's Windows PC (Docker Desktop
  or WSL, the stack, Tailscale or local-network https); updates delivered without git (published images, a signed
  update command); backups copied off the PC (USB drive or a free cloud folder such as Google Drive: the files are
  already encrypted); a UPS and power-cut recovery; per-install secrets kept by the buyer; remote support access
  with the buyer's consent; licensing or activation if you want it; terms and a privacy notice for buyers.

### 7.4 Go-live and first weeks — pilot runbook steps 8 and 9

- Day one on call; daily checks of jobs, alerts, backups and support requests; weekly reconciliation review with the
  accountant; fixes for what the pilot finds, each as its own slice with tests; a pilot report before a second hotel.

## Order

7.1 → 7.2 → 7.3 → 7.4. 7.2 and 7.3 depend on your accounts and people; 7.1 does not. Work continues on branch
`phase-7-pilot`, merged to `main` through a pull request when each slice is green.
