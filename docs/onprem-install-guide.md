# On-premises install: seller's guide

Status: 2026-10-29 (decision D22: InnPilot is sold and installed on each hotel's own Windows computer, one hotel per
computer; a cloud service follows after growth). This is for you, the seller: how to make an installer, what to
bring to a hotel, the install visit, upgrades and recovery. The hotel's staff never need any of it.

Nothing of yours is left on a hotel's computer: no password, key or account. Every secret is generated on that
computer at install, and the hotel keeps its own recovery kit.

## 1. Make the installer bundle (on your computer)

```bash
node deploy/onprem/build-bundle.mjs
```

It takes the version on `main`, checks its images are published and public, and writes
`deploy/onprem/out/InnPilot-<version>.zip` (about 30 KB: the computer downloads InnPilot itself). For a named
release, tag `main` as `v1.0.0`, wait for the Release workflow, then `--version v1.0.0`. Put the zip on a USB stick.

## 2. What the hotel needs before your visit

- A Windows 10 or 11 (64-bit) computer that stays on, with internet. Ask for a UPS: power cuts are the most common
  cause of downtime and of damaged databases.
- An email address for the owner (their sign-in name), and their phone for two-step sign-in (an authenticator
  app).
- A free **Tailscale** account in the hotel's name (sign in with the hotel's Google or Microsoft account). It gives
  the hotel its web address; the account is theirs, not yours.
- A **USB stick** for the recovery kit, and either **Google Drive for desktop** (the hotel's account) or a second
  USB drive for the daily copies.
- **Docker Desktop**: free for businesses under 250 people and under US$10 million a year (docker.com/pricing);
  the installer offers to install it.

## 3. The install visit

1. Install **Tailscale** on the computer, sign in with the hotel's account, rename the machine (for example
   `frontdesk`) in its admin console, and run `tailscale funnel --bg 8090` in PowerShell. Approve HTTPS and Funnel
   when it asks. Note the address it prints, `https://frontdesk.<name>.ts.net`.
2. Unzip the bundle, double-click **InnPilot-Install.cmd**. If Docker Desktop is missing it installs it: restart,
   open Docker Desktop once, accept its terms, then double-click the installer again.
3. Answer its questions: the address from step 1, the hotel's name, the owner's name and email, the folder for
   daily copies. It then downloads InnPilot, creates the hotel and the owner, proves the owner's first sign-in
   works, makes Docker start with Windows and starts the daily copy (about 5 minutes).
4. **Recovery kit:** it is on the desktop. With the owner, copy it to their USB stick (and a second place), then
   delete it from the desktop. Explain: without it, a lost computer means lost data.
5. The owner signs in at the address on their phone (on mobile data, to prove it works from outside), sets up
   two-step sign-in, changes the one-time password from the kit, and goes through the set-up guide with you.
6. Windows: Settings → System → Power, never sleep when plugged in.

## 4. Upgrades

Make a new bundle (step 1), unzip it on the hotel's computer and double-click **InnPilot-Install.cmd** again. It
recognises the existing install: no questions, settings and data kept, an encrypted backup taken before anything
changes, then the new version's database updates. Upgrades go forward only; if one must be undone, restore the
backup it took (docs/backup-and-restore.md).

## 5. When something goes wrong

- **Warnings:** the owner and manager see a banner in InnPilot when backups are late or background work fails.
- **Computer lost or broken:** new computer, steps 2 and 3 with the same Tailscale machine name, the settings from
  the recovery kit put back in `C:\ProgramData\InnPilot\settings`, then restore the newest daily copy; the
  procedure is the rebuild drill in docs/home-staging-runbook.md (`rebuild-drill.mjs --from-file`). Drill it once
  before your first real need.
- **Stop InnPilot:** `powershell -ExecutionPolicy Bypass -File C:\ProgramData\InnPilot\install.ps1 -Stop`.
- **Logs:** `docker compose -p innpilot-hotel logs api` in `C:\ProgramData\InnPilot`; the daily copy logs to
  `C:\ProgramData\InnPilot\logs\offsite.log`.

## Limits to tell the buyer

- InnPilot is only reachable while that computer is on, awake and online.
- Every visitor appears to come from one address behind Tailscale (docs/home-staging-runbook.md): sign-in limits
  are shared by the hotel's staff.
- Backups and the daily copy happen when the computer is on; at least one per day it is switched on.
- Licensing, support terms, a privacy notice and terms for buyers are not in place yet (Phase 7 plan, 7.3).

## Test record

2026-10-29, on the development computer, from a bundle of `sha-6da5d6155449` (published images), as a separate
install (project `innpilot-onprem-test`, port 8092, then removed): fresh install end to end, upgrade run (no
questions, 27 migrations already applied, hotel, owner and backups kept), and a final fresh install. The first runs
found three problems, fixed: programs started in the install folder before it existed; the owner's one-time password
reached InnPilot with an invisible byte-order mark in front (Windows' input encoding), so the owner could not sign in
(the installer now also proves the first sign-in before finishing); no backup was recorded on day one, so the owner
would have started with a "no backup" warning. Final run: owner's first sign-in works, the stored password matches
the kit exactly, one good backup recorded, daily copy made, settings without byte-order marks, the settings folder
readable only by the installing user, administrators and Windows. Not yet tested: a real Windows computer other than
this one, the Docker Desktop installation path, and a real Tailscale Funnel on an install made by the installer.
