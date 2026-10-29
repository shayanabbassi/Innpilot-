# Home staging runbook: your own computer + Tailscale Funnel

Status: slice 7.1 (2026-10-25). Without a payment card, Oracle Cloud and Cloudflare R2 cannot be opened, so staging
runs on your own Windows computer: the same single-server stack ([staging-runbook.md](staging-runbook.md) describes
the cloud form, kept for later), with object storage on the same computer and a free public https address from
Tailscale Funnel. Nothing here needs a card. This is also the shape of an on-premises install on a buyer's PC (D22).

**Steps marked "you"** need your own accounts or clicks; the rest I can run on this computer when you say so.

## What you need

- This computer, with Docker Desktop (installed) and the InnPilot repository (here).
- A free **Tailscale** account (sign in with Google, Microsoft or GitHub; no card).
- A private note in your password manager called "InnPilot home staging".

## 1. Keep the computer and Docker running (you)

- Docker Desktop → Settings → General → tick **Start Docker Desktop when you sign in to your computer**.
- Windows Settings → System → Power: **when plugged in, never sleep** (and closing the lid does nothing, if it is a
  laptop). Staging is only online while this computer is on and connected.

## 2. Tailscale (you)

1. Download Tailscale for Windows from tailscale.com/download and install it.
2. Sign in from its tray icon. This computer joins your private Tailscale network.
3. Optional: in the Tailscale admin console (login.tailscale.com) → Machines, rename this computer to something
   short, for example `innpilot-staging`; the name becomes part of the public address.

## 3. The public address (you, then me)

In a terminal:

```bash
tailscale funnel --bg 8090
```

The first time, it prints a link to turn on **HTTPS certificates** and **Funnel** for your network: open it,
approve, then run the command again. It prints the address, for example
`https://innpilot-staging.tail1234.ts.net`. Funnel keeps running in the background and after restarts.

Tailscale holds the certificate and forwards to InnPilot's proxy, which listens only on this computer
(`127.0.0.1:8090`).

## 4. Settings (me)

```bash
node deploy/local/init.mjs --dir deploy/home --origin https://<address from step 3> --buckets innpilot-staging
```

Writes `deploy/home/*.env` with fresh random secrets (git ignores them).

## 5. Save the settings off the computer (you; do not skip)

Copy every file in `deploy/home/` ending in `.env` into the password manager note (or onto a USB stick kept
elsewhere). `app.env` holds the keys that encrypt guests' document numbers and two-step secrets; without them a
restored backup cannot read those fields. `backup-private.env` is the only key that can open a backup: after
copying it, delete it from the computer (`deploy/home/backup-private.env`).

## 6. Release (me)

```bash
node deploy/home/release.mjs
```

Builds the images from this checkout, then runs the release as on a real server (role, encrypted backup,
migrations, start), creates a smoke-test hotel once, and runs the smoke test against the public address. To update
staging later: `git pull` on `main`, then the same command. To stop it: `node deploy/home/release.mjs --down` (the
data stays).

## 7. First check (you)

Open the address from step 3 on your phone (mobile data, not Wi-Fi, to prove it works from outside): the InnPilot
sign-in page with a valid certificate. Slice 7.2 continues with the first hotel account, the restore drill and
training.

## Limits (state them to anyone using it)

- **Online only while this computer is on**, awake and connected. Power and internet cuts take staging down;
  Docker brings it back when the computer restarts.
- **Everything is on one disk**: database, files and backups. A broken disk loses staging. Fine for fictional
  training data; an on-premises sale needs backups copied off the machine (slice 7.3).
- **Everyone appears as one visitor.** First every sign-in was audited as `172.20.0.1` (Docker's network gateway).
  With Caddy keeping the address Tailscale forwards (`Caddyfile.home`, `trusted_proxies`) and the API trusting two
  proxies (`compose.home.yml`, `TRUST_PROXY=2`), a forged `X-Forwarded-For` header is ignored, but a phone on
  mobile data (2026-10-25) was still recorded as this computer's own Tailscale address, `100.84.162.56`: Funnel
  forwards its own address, not the visitor's. So sign-in rate limits are shared by all visitors, and the audit log
  cannot tell visitors apart by address. Acceptable for staging and training; an install that needs per-visitor
  addresses needs a different front (a real server, or a tunnel that passes the visitor address on).

## First release record

2026-10-25, `https://inpilot.tail96c7fc.ts.net`, images built from `phase-7-pilot` at 058c1f6: role, encrypted
backup, 26 migrations, start; smoke-test hotel created; smoke test over the public address **6 passed, 0 failed**
(health, security headers, no-session and cross-site refusals, error envelope, sign-in and sign-out with secure
cookies); certificate valid.

## Backups when the computer is off at night

The nightly backup is at 21:00 UTC (02:00 in Pakistan). When this computer is off at that time, the backup
scheduler takes the missed backup as soon as Docker starts again (since 2026-10-29; before that, staging went four
days without one). So a backup happens at least once on every day the computer is switched on.

## Rebuild after a lost or broken computer (P7-6)

`node deploy/home/rebuild-drill.mjs` proves it, beside live staging: a fresh Compose project (`innpilot-rebuild`)
with empty volumes, the saved settings, a copy of the storage (backups and files), the role provisioned, the latest
backup restored with all eight checks and kept, made the live database, InnPilot started, then compared with live
staging and removed (`--keep` leaves it on `http://127.0.0.1:8091`).

**2026-10-29: passed in 58.1 s.** Backup of 29 October restored (8 of 8 checks), ready 200, smoke-test sign-in 200;
tenants 2, users 4, rooms 2, journals 2 on both; audit events 69 against 67 (the drill's own two sign-ins). Live
staging was not changed.

For a real rebuild on a new computer: install Docker Desktop, Tailscale (same account; set the same machine name and
`tailscale funnel --bg 8090`) and the repository; put the saved settings in `deploy\home`; copy the storage from the
off-site copy; then the same steps with the project name `innpilot-staging` and port 8090. **Until backups are
copied off this computer (7.2 item 5), a lost disk loses the backups with it.**

## Copies off this computer (7.2 item 5)

`node deploy/home/copy-offsite.mjs --to "<folder>"` packs the whole storage (the encrypted backups and the
application's files, which are encrypted too) into one file, `innpilot-storage-<time>.tar`, in a folder that leaves
this computer, and keeps the newest three there. The folder is remembered (`deploy/home/offsite.env`), so later runs
need no argument. Free choices: a **Google Drive for desktop** folder (synced to Google automatically, 15 GB free)
or a USB drive kept elsewhere. The file needs no extra password: without the backup key and `app.env` it cannot be
read.

Checked 2026-10-29 into a test folder: the copy holds exactly what storage holds, including the storage gateway's
extended attributes (16 of 16, needed for a rebuild); only the newest three copies stay; a missing folder is
refused with a clear message. A rebuild starts from such a file:
`node deploy/home/rebuild-drill.mjs --from-file <file>` (to be drilled with the key at the next drill).

**Set up 2026-10-29:** Google Drive for desktop, folder `G:\My Drive\InnPilot backups`; a Windows scheduled task,
"InnPilot off-site copy", runs `deploy\home\copy-offsite.cmd` daily at 15:00 (or as soon as the computer is on, if
it was off then) and logs to `%LOCALAPPDATA%\InnPilot\offsite.log`. First runs: by hand, then by the task (result 0);
two copies in Drive. To check: open the log, or look at the Drive folder's newest file date. To stop it: Task
Scheduler → "InnPilot off-site copy" → Disable.

## Warnings inside InnPilot (7.2 item 6)

No outside alert service (owner's choice, 2026-10-29: nothing of the owner's, such as a mail password, may sit on a
hotel's computer). Instead the **owner and general manager** see a banner above every page while a problem lasts:
no backup yet, the last good backup older than 26 hours, the last backup attempt failed, background tasks failing
or waiting too long; the same conditions as the alert rules. Other roles never see it. Switched on for a
single-hotel install (`IN_APP_SYSTEM_WARNINGS: 'true'` in `compose.home.yml`); off by default, for a hosted
multi-hotel service where the operator watches these instead.

Checked 2026-10-29: unit and end-to-end tests (owner and both kinds of manager see it; front desk, accountant,
auditor, cashier and housekeeping are refused; switched off it answers with nothing); released to staging (no
banner, backups healthy); in the browser with a local database that has no backup: the banner at 1280, 768 and 360
pixels without sideways scrolling, and none for front desk (no request made, the endpoint refuses it).

**Limit:** someone has to open InnPilot to see a warning, and a computer that is off warns no one.

## Route probe and light load run (7.2 item 7)

Both run from a container pinned to Funnel's public IPv4 relay (`--add-host <address>:<relay IP>`): from this
computer the address otherwise resolves to its own Tailscale address and never leaves it.

**Route probe, 2026-10-29** (`node scripts/probe-live.mjs https://<address>`): every route in the OpenAPI document,
signed out, over the internet: 201 routes; 196 refused a signed-out request; 113 routes that change data also
refused a foreign origin; the 3 public reads answered 200; no 5xx, no internals in any error. **No findings**
(2 min 39 s; 17 s from this computer). The in-process probe (`security-probe.e2e`) still covers roles and other
hotels on every change.

**Light load run, 2026-10-29** (`deploy/home/light-load.k6.js`, k6 2.2.0): 5 front-desk users for 2 minutes reading
the front desk, room board, reservations, guests and dashboard, with pauses as a person would; account
`load-desk@smoke-check.test` (front desk, Smoke Check Hotel, staging only, `deploy/home/load.env`). 260 requests,
**0 failed**, 250 of 250 checks; reads median 0.43 s, p95 **0.55 s** (threshold 1.5 s), slowest 1.6 s. The floor of
0.36 s is the trip to Tailscale's relay and back; the API itself answers these in about 0.2 s (phase-6-load-test).
A first run failed (87 % 401) because k6 clears cookies every round by default; `noCookiesReset` fixed the script.

## Restore drill (bring the key back for the run only)

1. Copy `backup-private.env` from your USB stick into `deploy\home`.
2. I run the drill: the latest backup is restored into a separate temporary database, checked and dropped; live
   staging is not touched. Record: [backup-and-restore.md](backup-and-restore.md), drill record.
3. Delete `deploy\home\backup-private.env` again.

- Tailscale Funnel is meant for light use; heavy traffic or a public launch belongs on a real server.
