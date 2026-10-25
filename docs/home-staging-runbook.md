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
- **Visitor addresses** (fixed in 7.2): at first every sign-in was audited as `172.20.0.1`, Docker's network
  gateway, so rate limits were shared by everyone. Caddy now keeps the address Tailscale forwards
  (`Caddyfile.home`, `trusted_proxies`) and the API trusts two proxies (`compose.home.yml`, `TRUST_PROXY=2`): sign-ins
  are audited with the visitor's own address, and a forged `X-Forwarded-For` header is ignored. Anyone signed in to
  this computer itself can still reach the proxy directly on `127.0.0.1:8090`; that is acceptable for staging.

## First release record

2026-10-25, `https://inpilot.tail96c7fc.ts.net`, images built from `phase-7-pilot` at 058c1f6: role, encrypted
backup, 26 migrations, start; smoke-test hotel created; smoke test over the public address **6 passed, 0 failed**
(health, security headers, no-session and cross-site refusals, error envelope, sign-in and sign-out with secure
cookies); certificate valid.

- Tailscale Funnel is meant for light use; heavy traffic or a public launch belongs on a real server.
