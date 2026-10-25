# Incident response

Status: slice 6.6 (2026-10-22). Covers 05 Security & Deployment Runbook §4: severity definitions, owner,
containment, evidence preservation, customer communication and post-mortem. Each alert in
`deploy/monitoring/alerts.yml` links to its section below.

## Before the first hotel goes live (yours)

- **Name the owners.** An incident owner (decides, communicates) and a technical responder (investigates, fixes),
  plus a deputy for each. Write their names and phone numbers here and in the alert destinations.
- **Set the alert destinations** in `deploy/monitoring/alertmanager.yml` (from `alertmanager.example.yml`): critical
  alerts to the on-call phone and email, warnings to the team channel. Then test the path (below).
- **Name the support contact** each hotel calls, and the hours it answers.
- **Ask your legal adviser** what Pakistan's law and your customer terms require when personal data is exposed:
  who must be told, how fast, and in what form. Record the answer under "Personal data" below.

| Role                | Name | Phone | Deputy |
| ------------------- | ---- | ----- | ------ |
| Incident owner      |      |       |        |
| Technical responder |      |       |        |
| Hotel support       |      |       |        |

## Severity

| Severity          | Meaning                                                                                                                                                 | Respond           | Tell hotels                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------- |
| **SEV1 critical** | Hotels cannot work (sign-in, check-in, check-out or payments down), data may be wrong (ledger, folios), or personal data may be exposed to anyone else. | At once, any hour | Within 1 hour, then every 2 hours |
| **SEV2 major**    | A feature hotels rely on fails or is very slow, or a safety net is down (backups failing, alerts not arriving), with a workaround.                      | Within 2 hours    | If they are affected, same day    |
| **SEV3 minor**    | Something is degraded with little effect on hotels (one report slow, one background job failing and retrying).                                          | Next working day  | Not unless asked                  |

When unsure, choose the higher severity; lower it once you know more.

## The first 30 minutes

1. **Acknowledge** the alert and name the incident owner. Start a written timeline (time in UTC, what was seen,
   what was done, by whom): it becomes the post-mortem.
2. **Assess**: what do hotels see, since when, how many? `GET /api/v1/health/ready`, the Grafana dashboard
   (InnPilot overview), the API's logs (search by request ID for one failing request).
3. **Contain** before fixing (below). Stopping harm comes before finding the cause.
4. **Preserve evidence** (below) before anything that would destroy it, such as restarting, restoring or deleting.
5. **Communicate** (templates below) as soon as the severity is known.

## Containment

- **Bad release:** run `release.sh` with the previous image tags (docs/deployment-runbook.md, Rollback).
- **Suspected account takeover:** disable the user (Staff screen), which ends their sessions; reset their password
  and two-step verification; check the audit log for what the account did.
- **Suspected operator misuse:** end the operator's support access (platform console) and their sessions.
- **Password guessing:** rate limits and lockouts already slow it. If it continues, block the source address at the
  proxy or provider firewall.
- **Leaked secret:** rotate it at once. Database password: `db provision` with a new `APP_DB_PASSWORD`, update
  `app.env`, release. Storage keys: in the provider, then `app.env`. `MFA_ENCRYPTION_KEY` or `PII_ENCRYPTION_KEY`:
  these cannot simply be replaced (stored data depends on them); treat as SEV1 and plan a re-encryption.
- **Data damaged:** stop the cause first (disable the feature or roll back), then recover
  (docs/backup-and-restore.md, Recovering for real). Never edit posted financial records by hand.

## Evidence preservation

Before restarting, restoring or cleaning anything:

- Export the API and proxy logs for the period (the platform's log store, or `docker compose logs --since …`).
- Export the audit log for the affected tenants (Audit screen, or a database query as owner) and the platform
  audit log for operator actions.
- Keep the database: take a backup now (`node dist/ops/cli.js backup`); for suspected tampering, also keep a
  provider snapshot.
- Note the image tags running (`docker compose images`) and the configuration in force (not the secret values).
- Keep the copies read-only and record who has them. Personal data in them stays under the same rules as the
  live system.

## Communication

Say what is known, what hotels should do, and when the next update comes. Never guess the cause in public, and
never share another hotel's information.

> **Status (SEV1, first message):** InnPilot is not working properly since [time, PKT]. [What hotels see.] We are
> working on it now. Until it is fixed, please [record bookings and payments on paper / use the printed arrivals
> list]. Next update by [time].

> **Resolved:** InnPilot is working normally again since [time]. [What happened, in one sentence.] [Anything
> hotels need to do, e.g. enter paper records.] We are sorry for the trouble; a short report follows within
> [5 working days].

> **Personal data (only after the incident owner and legal adviser agree):** On [date] we found that [what
> happened]. The information involved was [categories, never the data itself]. We have [what was done]. [What the
> hotel should do.] Contact [support contact] with any questions.

### Personal data

If guest identity documents, contact details or staff data may have reached anyone who should not have them, it
is SEV1. The incident owner and the legal adviser decide who is told and when; record the decision and the reasons
in the timeline. Legal requirements: _to be filled in from the legal adviser's answer._

## Post-mortem

Within 5 working days of every SEV1 and SEV2, blameless, written from the timeline:

1. Summary: what happened, impact (hotels, duration, data), severity.
2. Timeline (UTC).
3. Cause: what failed, and why our safeguards (tests, review, alerts) did not stop it.
4. What went well, what did not.
5. Actions: each with an owner and a date (a test, an alert, a runbook change, a fix).

Keep post-mortems in `docs/incidents/`, and check open actions at the next one.

## Alerts and first steps

### API down

`InnPilotApiDown`: Prometheus cannot scrape the API for 2 minutes. Check the host and containers
(`docker compose ps`, `logs api`), then the provider's status page. A crash loop after a release: roll back. Out
of memory: restart, then look for the cause (memory panel).

### Not ready

`InnPilotNotReady`: the API is up but cannot use a dependency (`dependency` label). Database: the provider's
database status, connection limits, credentials. Storage: bucket, credentials, provider status. Migrations: a
release started without migrating; run the migrate step.

### Errors

`InnPilotHighErrorRate`: over 5% of requests fail with a server error. Find the route (dashboard, or logs at error
level with `ErrorReporter`); the request ID ties a report to its request. After a release: roll back first.

### Slow

`InnPilotSlowResponses` (p95 over 1 s for 10 minutes) and `InnPilotMemoryHigh`. Check the slowest routes panel,
database load, and whether a large export or report is running. The performance targets and their measurements
are in docs/phase-5-performance.md.

### Database capacity

`InnPilotDatabasePoolSaturated`: requests wait for a database connection. Look for slow queries (provider
insights), a stuck transaction, or more API instances than the database allows connections for.

### Jobs

`InnPilotJobsFailing` and `InnPilotJobBacklog`. Failed jobs record a reason (the person who asked sees it on My
exports); logs carry the error report. A backlog with no failures means no worker is running (`JOBS_POLL_SECONDS`
set to 0 everywhere, or the API instances stopped).

### Backups

`InnPilotBackupTooOld` (no good backup for 26 hours), `InnPilotBackupMissing` and `InnPilotBackupFailed`: SEV2,
since the next problem would have no safety net. Check the `backups` container's log (`backup.failed` events),
the backup bucket and its credentials, then run a backup by hand
(`docker compose --profile release run --rm backup`) and confirm the alert clears.

### Sign-in spike

`InnPilotFailedSignInSpike` (over 30 failed sign-ins or codes in 10 minutes) and `InnPilotAccountsLocking`.
Usually password guessing. The audit log's `auth.login_failed` events show which accounts and addresses; lockouts
protect the accounts. Contain as above; tell affected hotels if their accounts were targeted.

## Testing the alert path

The alert rules have unit tests (`deploy/monitoring/alerts.test.yml`, run in CI). To prove alerts reach their
destinations: locally, `node deploy/local/up.mjs --alert-drill` stops the API and waits for the alert, and its
resolution, at a test receiver (also run in CI). In staging and production, after setting the real destinations,
send a test alert and confirm every destination receives it:

```bash
docker compose --profile monitoring exec alertmanager amtool alert add InnPilotTestAlert severity=critical --annotation=summary="Test: please acknowledge" --alertmanager.url=http://localhost:9093
```

Record the date and who confirmed receipt; repeat after any change to the destinations, and every three months.
