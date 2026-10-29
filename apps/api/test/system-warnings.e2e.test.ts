/**
 * Phase 7 slice 7.2 — system warnings inside InnPilot (the owner's choice over an outside alert service). Owner and
 * manager only, including a manager assigned to one property; never the read-everything roles; empty while the
 * switch is off (a hosted multi-hotel service); the backup and background-work conditions of the alert rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type Harness } from './harness';

describe('system warnings', () => {
  describe('switched on (single-hotel install)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness({ env: { IN_APP_SYSTEM_WARNINGS: 'true' } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('is for the owner and managers only, not the read-everything roles', async () => {
      for (const u of ['ownerA', 'managerA', 'managerA1'] as const) {
        const res = await (await browser(h).loginActive(h.fx.users[u])).get('/system/warnings');
        expect(res.status, u).toBe(200);
        expect(res.body.data.enabled).toBe(true);
      }
      for (const u of ['deskA', 'accountantA', 'auditorA', 'cashierA', 'housekeepingA'] as const) {
        const res = await (await browser(h).loginActive(h.fx.users[u])).get('/system/warnings');
        expect(res.status, u).toBe(403);
      }
      expect((await browser(h).get('/system/warnings')).status).toBe(401);
    });

    it('reports a missing backup, then an old one, then a failed attempt, then nothing', async () => {
      const owner = await browser(h).loginActive(h.fx.users.ownerA);
      const codes = async () =>
        ((await owner.get('/system/warnings')).body.data.warnings as { code: string }[]).map((w) => w.code);

      expect(await codes()).toEqual(['backup_missing']);

      const old = new Date(Date.now() - 30 * 3_600_000);
      await h.admin.query(
        `INSERT INTO backup_runs (started_at, finished_at, ok, object_key, bytes, duration_ms)
         VALUES ($1, $1, true, 'daily/old.ipbk', 100, 1000)`,
        [old],
      );
      const res = await owner.get('/system/warnings');
      expect(res.body.data.warnings).toEqual([
        { code: 'backup_too_old', severity: 'critical', since: old.toISOString(), count: null },
      ]);

      await h.admin.query(
        `INSERT INTO backup_runs (started_at, ok, duration_ms, error) VALUES (now(), false, 10, 'pg_dump exited with 1')`,
      );
      expect(await codes()).toEqual(['backup_too_old', 'backup_failed']);

      await h.admin.query(
        `INSERT INTO backup_runs (started_at, finished_at, ok, object_key, bytes, duration_ms)
         VALUES (now(), now(), true, 'daily/new.ipbk', 100, 1000)`,
      );
      expect(await codes()).toEqual([]);
    });

    it('reports failed background work, with the count, and never the reason or the hotel it belonged to', async () => {
      await h.admin.query(
        `INSERT INTO jobs (tenant_id, kind, payload, created_by, status, attempts, finished_at, last_error)
         VALUES ($1, 'report_export', '{}', $2, 'failed', 1, now(), 'internal reason')`,
        [h.fx.tenantB, h.fx.users.ownerB.id],
      );
      const res = await (await browser(h).loginActive(h.fx.users.ownerA)).get('/system/warnings');
      expect(res.body.data.warnings).toEqual([
        { code: 'jobs_failing', severity: 'warning', since: null, count: 1 },
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/internal reason|report_export/);
    });
  });

  describe('switched off (hosted multi-hotel service, the default)', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('answers with an empty list, even with no backup at all', async () => {
      const res = await (await browser(h).loginActive(h.fx.users.ownerA)).get('/system/warnings');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ enabled: false, warnings: [] });
    });
  });
});
