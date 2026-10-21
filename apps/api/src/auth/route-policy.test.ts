import { describe, expect, it } from 'vitest';
import { collectRoutes } from '../openapi/routes';

describe('route access policies', () => {
  it('are declared on every route (deny by default)', () => {
    const all = collectRoutes();
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((r) => !r.policy).map((r) => r.handler)).toEqual([]);
  });

  it('keep public routes to the known list', () => {
    const publicRoutes = collectRoutes()
      .filter((r) => r.policy?.kind === 'public')
      .map((r) => r.key)
      .sort();
    expect(publicRoutes).toEqual(['GET /health', 'POST /auth/login', 'POST /platform/auth/login']);
  });

  it('keeps platform routes for operators only and tenant routes for hotel sessions only', () => {
    for (const r of collectRoutes()) {
      if (r.key === 'POST /platform/auth/login') continue;
      expect(r.policy?.kind === 'platform', r.key).toBe(r.path.startsWith('/platform'));
    }
  });
});
