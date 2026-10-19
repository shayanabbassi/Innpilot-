import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/common/app-error';
import { Db } from '../src/db/db.module';
import { IdempotencyService } from '../src/idempotency/idempotency.service';
import { startHarness, type Harness } from './harness';

let h: Harness;
let db: Db;
let service: IdempotencyService;

beforeAll(async () => {
  h = await startHarness();
  db = h.app.get(Db);
  service = h.app.get(IdempotencyService);
});

afterAll(async () => {
  await h?.close();
});

const cmd = (key: string, body: unknown) => ({
  tenantId: h.fx.tenantA,
  actorUserId: h.fx.users.deskA.id,
  scope: 'POST /test-payments',
  key,
  body,
});

describe('idempotency', () => {
  it('runs once and replays the stored result for a retry', async () => {
    let calls = 0;
    const run = () =>
      db.tenant(h.fx.tenantA, (tx) =>
        service.run(tx, cmd('retry-key-0001', { amount: '1500.00' }), async () => {
          calls++;
          return { status: 201, body: { paymentId: 'p-1' } };
        }),
      );
    const first = await run();
    const second = await run();
    expect(calls).toBe(1);
    expect(first).toEqual({ status: 201, body: { paymentId: 'p-1' }, replayed: false });
    expect(second).toEqual({ status: 201, body: { paymentId: 'p-1' }, replayed: true });
  });

  it('treats key order in the body as the same request', async () => {
    const run = (body: unknown) =>
      db.tenant(h.fx.tenantA, (tx) =>
        service.run(tx, cmd('order-key-0001', body), async () => ({ status: 200, body: { ok: true } })),
      );
    await run({ a: '1', b: '2' });
    expect((await run({ b: '2', a: '1' })).replayed).toBe(true);
  });

  it('rejects the same key with a different request', async () => {
    const run = (amount: string) =>
      db.tenant(h.fx.tenantA, (tx) =>
        service.run(tx, cmd('reuse-key-0001', { amount }), async () => ({ status: 201, body: {} })),
      );
    await run('100.00');
    await expect(run('999.00')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('lets a failed command be retried, because the key rolls back with it', async () => {
    let calls = 0;
    const run = (fail: boolean) =>
      db.tenant(h.fx.tenantA, (tx) =>
        service.run(tx, cmd('fail-key-0001', { amount: '5.00' }), async () => {
          calls++;
          if (fail) throw new AppError('CONFLICT', 'simulated failure');
          return { status: 201, body: { ok: true } };
        }),
      );
    await expect(run(true)).rejects.toThrow('simulated failure');
    expect((await run(false)).replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('executes exactly once under concurrent duplicate requests', async () => {
    let calls = 0;
    const run = () =>
      db.tenant(h.fx.tenantA, (tx) =>
        service.run(tx, cmd('race-key-0001', { amount: '42.00' }), async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 200));
          return { status: 201, body: { n: calls } };
        }),
      );
    const results = await Promise.all([run(), run(), run()]);
    expect(calls).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it('keeps keys per tenant', async () => {
    const forTenant = (tenantId: string, actorUserId: string) =>
      db.tenant(tenantId, (tx) =>
        service.run(tx, { ...cmd('shared-key-0001', {}), tenantId, actorUserId }, async () => ({
          status: 200,
          body: { tenantId },
        })),
      );
    const a = await forTenant(h.fx.tenantA, h.fx.users.deskA.id);
    const b = await forTenant(h.fx.tenantB, h.fx.users.deskB.id);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });

  it('requires a well-formed key', async () => {
    await expect(
      db.tenant(h.fx.tenantA, (tx) =>
        service.run(tx, cmd('short', {}), async () => ({ status: 200, body: {} })),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
