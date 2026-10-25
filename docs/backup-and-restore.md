# Backups and restore

Status: slice 6.5 (2026-10-22). Targets from PRD §9: recovery point within 15 minutes, recovery time within 4 hours.
"A backup is not proven until restoration has been tested": the drill below is the proof, and it is repeated in
staging and production.

## Two layers

1. **The provider's point-in-time recovery** (yours, D17): the managed database's continuous backup, which meets
   the 15-minute recovery point. Turn it on with the longest retention the plan allows.
2. **The nightly encrypted logical backup** (this slice): a full `pg_dump` every night, encrypted, kept in a bucket
   separate from the application, with daily and monthly copies. It survives the loss of the database service, the
   provider account being compromised (if the bucket is in another account), or a bad migration found days later.

## How a backup works

`node dist/ops/cli.js backup` (the `backups` service runs it every night at `BACKUP_AT_UTC`, default 21:00 UTC,
02:00 in Pakistan; `release.sh` runs it before every migration):

- Opens a read-only snapshot, counts the rows of every table and records the applied migrations, then runs
  `pg_dump` **in the same snapshot**, so the counts describe exactly what was dumped.
- Encrypts the dump with a fresh AES-256-GCM key, which is itself encrypted with the **backup public key**
  (RSA-4096, OAEP). The backup job cannot decrypt anything; whoever takes the bucket learns nothing.
- Stores `daily/<UTC time>.ipbk` in the backup bucket; the first backup of each month is also kept as
  `monthly/<YYYY-MM>.ipbk`; `latest.json` records the newest backup (time, size, checksum, key id). The monitoring
  slice (6.6) alerts when `latest.json` is older than 26 hours.
- Retention: nightly backups for 35 days, monthly copies for 12 months (the newest backup is never deleted). These
  periods are defaults until your accountant and legal adviser confirm them.

## Keys: the one thing to get right

`node dist/ops/cli.js keygen` prints a key pair once (on a single server, `deploy/single/init-env.sh` makes it in
the same format):

- `BACKUP_PUBLIC_KEY` goes into `backup.env` on the host.
- `BACKUP_PRIVATE_KEY` is the **only** way to read any backup. Keep it **offline**: in a password manager with
  two people able to reach it, and a printed copy in a safe. Never on the server. If it is lost, every backup made
  with its public key is unreadable; if it leaks, rotate (new pair, new backups) and treat old backups as exposed.
- The key id in `latest.json` tells which pair a backup needs.

## The restore drill

`node dist/ops/cli.js restore-drill` (compose service `restore-drill`, with the private key given for that run
only, see `deploy/compose.yml`):

1. Downloads the newest backup (or `--key daily/...`), checks it against the checksum in `latest.json`, decrypts
   and authenticates it (any change to the file or its manifest fails here).
2. Creates a **new, isolated database** `innpilot_restore_<time>` and restores into it. It never restores over a
   live database, and never changes an existing database role.
3. Integrity checks against the restored copy:
   - migrations at the version recorded in the backup, each matching this release's files;
   - every table holds exactly the rows counted at backup time;
   - every tenant's trial balance balances, and every posted journal equals its lines;
   - every folio's own balance (charges, payments, refunds, write-off) equals its ledger lines;
   - every cash and bank ledger line carries its account, on the right ledger account;
   - the audit log is complete and still append-only;
   - row-level security is on for every table with tenant data.
4. Starts the real API against the copy and signs in with a dedicated account (`DRILL_SIGNIN_EMAIL` and
   `DRILL_SIGNIN_PASSWORD`; the sign-in writes into the copy only, so the row counts are taken first).
5. Drops the copy (`--keep` keeps it for inspection) and prints the timed report (`--report drill.md` saves it).

The drill exits non-zero if any check fails. Record each drill's report below.

## Recovering for real

- **Lost or damaged data, database service healthy:** use point-in-time recovery to a new instance at the time
  just before the damage; check it with the integrity checks (`restore-drill --key` against a backup of it, or
  run the checks by hand); point `DATABASE_URL` at it; release.
- **Database service lost, or the damage is older than point-in-time retention:** restore the latest suitable
  nightly backup with `restore-drill --keep`; when every check passes, point `DATABASE_URL` and
  `DATABASE_ADMIN_URL` at the kept database and release. Data after that backup must be re-entered from paper
  records; tell the hotel which period.
- **A migration must be undone:** the backup `release.sh` took just before it is in the bucket; restore it as
  above and release the previous images.
- Every recovery is an incident: record the time, the cause, what was restored, and what was re-entered.

## Settings (backup.env)

`BACKUP_STORAGE_ENDPOINT`, `BACKUP_STORAGE_REGION`, `BACKUP_BUCKET`, `BACKUP_ACCESS_KEY_ID`,
`BACKUP_SECRET_ACCESS_KEY` (a bucket in a **separate account or project** from the application's storage, with
versioning or object lock if the provider offers it, and credentials limited to that bucket), `BACKUP_PUBLIC_KEY`,
optional `BACKUP_AT_UTC`. The backup and drill also read `DATABASE_ADMIN_URL` from `release.env`; the drill reads
`app.env` for the sign-in check. Hardening for later: a dedicated read-only role for `pg_dump` instead of the
database owner.

## Drill record

### 2026-10-22: local, 100-room year (`pnpm --filter @innpilot/api test:perf restore-drill`)

Dataset: 12,134 reservations, 24,268 room nights, 24,391 journals (49,512 lines), 29,200 audit events.
Backup: 9.1 MB encrypted, 190,933 rows, made in 4.6 s.

Backup restored into a new database and dropped afterwards. **Passed** in 18.5 s (target: 4 hours).

| Step                        | Time   |
| --------------------------- | ------ |
| Download the backup         | 0.2 s  |
| Check and decrypt           | 0.1 s  |
| Create an isolated database | 0.1 s  |
| Restore                     | 15.2 s |
| Integrity checks            | 1.0 s  |
| Sign-in check               | 0.3 s  |
| Drop the restored database  | 1.7 s  |

| Check                                              | Result | Detail                                                                 |
| -------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| Migrations at the expected version                 | ok     | 25 applied, latest 0025_jobs.sql (same as this release)                |
| Every table has the rows it had when backed up     | ok     | 65 tables, 190,933 rows                                                |
| Every tenant's trial balance balances              | ok     | 1 tenant, 24,391 posted journals; none unbalanced                      |
| Folio balances equal their ledger lines            | ok     | 12,134 folios; 0 differ                                                |
| Cash and bank accounts equal their ledger accounts | ok     | 9 accounts; no line without its account or on the wrong ledger account |
| Audit log intact and append-only                   | ok     | 29,205 events, append-only guards in place                             |
| Row-level security on every tenant table           | ok     | 57 tables with tenant data, all protected                              |
| A user can sign in to the restored copy            | ok     | signed in (two-step verification next)                                 |

The first run took 91 s, 75 s of it in the folio check (one subquery per folio); rewritten as single-pass totals it
takes under a second. Times are on a laptop with Docker; the restore step scales with data size.

### 2026-10-22: local production-like stack (`node deploy/local/up.mjs`)

The same drill run by the production images inside the Compose stack: an encrypted backup before migrating, a
second after the smoke-test hotel was created, then the drill with the private key given for that run only. All
eight checks passed (restore 8.2 s, total 9.8 s). CI repeats this on every pull request.

### Still to do (yours)

The same drill in staging, then in production, once they exist (D17): generate the key pair, store the private key
offline, create the backup bucket in a separate account, run `release.sh` (which takes the first backup), then the
drill with a dedicated drill account. Record each run here, and repeat at least every three months and after any
change to the database or backup set-up.
