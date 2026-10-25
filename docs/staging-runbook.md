# Staging runbook: Oracle Always Free + Cloudflare R2

Status: slice 7.1 (2026-10-25). Decision D17: staging on one Oracle Cloud Always Free machine, files and backups on
Cloudflare R2, at no cost. This is the step-by-step for you; each step says what to write down and where it goes.
Background and limits: [phase-7-plan.md](phase-7-plan.md) (P7-1 to P7-8). Production is not built this way (D21).

**Keep a private note open** (a password manager entry called "InnPilot staging"). Several steps produce a value to
save there. Nothing in this runbook ever goes into git, chat or an email.

Time needed: about 1.5 hours, most of it waiting for accounts and the first release.

---

## 1. Oracle Cloud account

1. Sign up at oracle.com/cloud/free. A payment card is needed to verify you; Always Free use is not charged.
2. **Home region** cannot be changed later. Choose one near Pakistan where Arm capacity is available, for example
   UAE East (Dubai), Saudi Arabia West (Jeddah) or India West (Mumbai).
3. Recommended (P7-6): once the account is active, upgrade it to **Pay As You Go** (Billing → Upgrade). Oracle's
   2023 notice says idle free machines are reclaimed only on free accounts; usage within the Always Free limits
   still costs nothing. Then set a **budget alert** of 1 US dollar (Billing → Budgets) so any charge is noticed at
   once.

## 2. The virtual machine

1. On your laptop, make an SSH key for **you** (if you do not have one): `ssh-keygen -t ed25519 -C "my laptop"`.
2. Oracle console → Compute → Instances → **Create instance**:
   - Image: **Canonical Ubuntu 24.04**.
   - Shape: **Ampere → VM.Standard.A1.Flex**, **2 OCPUs, 12 GB memory** (the Always Free allowance in 2026; all
     your Arm machines together must stay within it, or Oracle disables them).
   - Networking: a new virtual cloud network with a **public IPv4 address**.
   - SSH keys: paste the **public** half of your key (`~/.ssh/id_ed25519.pub`).
   - Boot volume: 100 GB (Always Free includes 200 GB in total).
3. "Out of capacity": try another availability domain, or again later; this is common for free Arm machines.
4. **Write down:** the public IP address.
5. **Open the web ports in Oracle's network:** the instance's subnet → Security List → Add ingress rules: source
   `0.0.0.0/0`, TCP, destination ports `80` and `443`. (SSH, port 22, is already open.)

## 3. Address (free)

1. Sign in at duckdns.org, add a subdomain (for example `innpilot-staging`), and set its IP to the machine's public
   IP. Your own domain works the same way: an `A` record to that IP.
2. **Write down:** the full address, for example `innpilot-staging.duckdns.org`. Caddy gets its HTTPS certificate
   by itself on the first release.

## 4. Cloudflare R2 (files and backups)

1. Create a Cloudflare account and open **R2** (activating R2 asks for a payment method; the free allowance is about
   10 GB).
2. Create **two buckets**: `innpilot-staging-files` and `innpilot-staging-backups` (location hint: Asia-Pacific).
3. R2 → **Manage API tokens** → create **two tokens**, each with **Object Read & Write** and **limited to one
   bucket** (P7-3): one for the files bucket, one for the backups bucket.
4. **Write down,** for each token: Access Key ID and Secret Access Key (shown once). Also the **S3 endpoint**:
   `https://<account id>.r2.cloudflarestorage.com` (on the R2 overview page).

## 5. The deploy key (for GitHub Actions)

On your laptop:

```bash
ssh-keygen -t ed25519 -f innpilot-deploy -C innpilot-deploy -N ""
```

This makes `innpilot-deploy` (private: goes into GitHub in step 9) and `innpilot-deploy.pub` (public: goes onto the
server in step 6). Keep the private file in your password manager too, then delete it from the laptop after step 9.

## 6. Prepare the server

From the repository folder on your laptop (replace `<ip>`):

```bash
scp deploy/single/setup-server.sh deploy/single/init-env.sh ubuntu@<ip>:
ssh ubuntu@<ip>
```

On the server:

```bash
sudo sh setup-server.sh "<paste the one line from innpilot-deploy.pub>"
```

It installs security updates and Docker, opens only ports 22, 80 and 443, and creates the `deploy` user that owns
`/opt/innpilot`. If it says a reboot is needed: `sudo reboot`, wait a minute, connect again.

Then write the settings (it asks for the address and the R2 values from steps 3 and 4; secrets are not shown as
you type):

```bash
sudo install -o deploy -g deploy -m 600 init-env.sh /opt/innpilot/
sudo -u deploy sh -c 'cd /opt/innpilot && sh init-env.sh'
```

## 7. Save the settings off the machine (do not skip)

The machine can be lost (P7-6). Three things are needed to rebuild it, and only you will have them:

- `backup-private.env`: the only key that can read the backups.
- `app.env`: holds the keys that encrypt guests' identity-document numbers and two-step-verification secrets. A
  restored database is unreadable in those fields without these exact keys.
- `release.env`, `postgres.env`, `backup.env`, `monitoring.env`: the rest of the settings.

Copy them to your laptop, store each in the password manager entry, then delete the private key from the server
and the copies from the laptop:

```bash
# on the server
sudo tar -C /opt/innpilot -czf /home/ubuntu/innpilot-settings.tgz app.env release.env postgres.env backup.env monitoring.env backup-private.env
sudo chown ubuntu /home/ubuntu/innpilot-settings.tgz
# on your laptop
scp ubuntu@<ip>:innpilot-settings.tgz .
# on the server again
rm /home/ubuntu/innpilot-settings.tgz
sudo rm /opt/innpilot/backup-private.env
```

## 8. Make the images public

GitHub → your profile → **Packages** → `innpilot-api` and `innpilot-web` → Package settings → Change visibility →
**Public**. The source is public already and the images hold no secrets; this lets the server pull them without a
GitHub token.

## 9. Connect GitHub to the server

In the repository on GitHub, **Settings**:

1. **Environments** → New environment `staging`:
   - Variables: `DEPLOY_USER` = `deploy`; `DEPLOY_DIR` = `/opt/innpilot`; `SITE_ADDRESS` = the address from step 3;
     `COMPOSE_FILES` = `-f compose.yml -f compose.single.yml`.
   - Secrets: `DEPLOY_SSH_KEY` = the whole content of the private file `innpilot-deploy`; `DEPLOY_KNOWN_HOSTS` = the
     output of `ssh-keyscan -t ed25519 <ip>` run on your laptop (the fingerprint must match the one your first
     `ssh` in step 6 showed).
2. **Secrets and variables → Actions → Variables** (repository): `STAGING_HOST` = the machine's public IP.

From then on every merge to `main` builds the images, deploys them to staging (role, backup, migrations, start) and
runs the smoke test. To deploy the current `main` straight away: Actions → Release → the latest run → **Re-run all
jobs**.

## 10. First check

Open `https://<address>`: the InnPilot sign-in page, with a valid certificate. Then tell me; slice 7.2 continues
with the first hotel account on staging, the restore drill, the rebuild drill, monitoring with real alert
destinations and a load run.

---

## Limits to remember (P7-5, P7-6)

- **At most a day lost:** one nightly encrypted backup to R2 (21:00 UTC, 02:00 in Pakistan); no point-in-time
  recovery. Fine for staging and training, not for a hotel's real money (D21).
- **Oracle may reclaim an idle free machine**, or change the free allowance. Nothing is lost that the backup and
  your saved settings (step 7) do not hold; rebuilding means steps 2, 3 (new IP), 6 with the saved settings
  instead of `init-env.sh`, 9 (new IP and host key), then restoring the latest backup. Slice 7.2 drills this once
  and writes the exact commands here.
- **Security updates install automatically**; reboot when `ssh` greets you with "System restart required".
