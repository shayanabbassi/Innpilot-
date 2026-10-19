import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;

beforeAll(async () => {
  h = await startHarness();
  owner = await browser(h).loginActive(h.fx.users.ownerA);
});

afterAll(async () => {
  await h?.close();
});

const complete = (c: BrowserClient, propertyId: string) =>
  c.post(`/properties/${propertyId}/onboarding/complete`);

describe('property onboarding', () => {
  it('starts incomplete for a new property', async () => {
    const me = await owner.get('/auth/me');
    const p = me.body.data.properties.find((x: { id: string }) => x.id === h.fx.propA1);
    expect(p.onboardingCompleted).toBe(false);
    expect((await owner.get(`/properties/${h.fx.propA1}`)).body.data.onboardingCompletedAt).toBeNull();
  });

  it('refuses to finish while required details are missing, naming each field', async () => {
    const res = await complete(owner, h.fx.propA1);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(
      ['addressLine', 'city', 'legalName', 'phone'].sort(),
    );
  });

  it('finishes once details are filled in, once only, with one audit event', async () => {
    const patch = await owner.patch(`/properties/${h.fx.propA1}`, {
      legalName: 'A One Hospitality (Pvt) Ltd',
      addressLine: '10 Test Road',
      city: 'Lahore',
      phone: '+92 300 0000000',
    });
    expect(patch.status).toBe(200);

    const first = await complete(owner, h.fx.propA1);
    expect(first.status).toBe(200);
    expect(first.body.data.onboardingCompletedAt).toEqual(expect.any(String));

    const again = await complete(owner, h.fx.propA1);
    expect(again.status).toBe(200);
    expect(again.body.data.onboardingCompletedAt).toBe(first.body.data.onboardingCompletedAt);

    const me = await owner.get('/auth/me');
    expect(
      me.body.data.properties.find((x: { id: string }) => x.id === h.fx.propA1).onboardingCompleted,
    ).toBe(true);

    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = 'property.onboarding_completed'`,
      [h.fx.propA1],
    );
    expect(rows[0].n).toBe(1);
  });

  it('is not available to front desk', async () => {
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    const res = await complete(desk, h.fx.propA2);
    expect(res.status).toBe(403);
  });

  it("hides other properties and other tenants' properties", async () => {
    const managerA1 = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await complete(managerA1, h.fx.propA2)).status).toBe(404);
    expect((await complete(owner, h.fx.propB1)).status).toBe(404);
    const { rows } = await h.admin.query(
      'SELECT onboarding_completed_at FROM properties WHERE id = ANY($1)',
      [[h.fx.propA2, h.fx.propB1]],
    );
    expect(
      rows.every((r: { onboarding_completed_at: Date | null }) => r.onboarding_completed_at === null),
    ).toBe(true);
  });
});
