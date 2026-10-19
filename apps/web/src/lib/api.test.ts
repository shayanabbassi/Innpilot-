import { ROLE_CODES } from '@innpilot/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { api, ApiError } from './api';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('unwraps the success envelope', async () => {
    vi.stubGlobal('fetch', respond(200, { data: { id: 'x' }, meta: { requestId: 'r1' } }));
    await expect(api.get('/thing')).resolves.toEqual({ id: 'x' });
  });

  it('returns items and the cursor for paged lists', async () => {
    vi.stubGlobal('fetch', respond(200, { data: [1, 2], meta: { requestId: 'r', nextCursor: 'abc' } }));
    await expect(api.page('/list')).resolves.toEqual({ items: [1, 2], nextCursor: 'abc' });
  });

  it('turns the error envelope into an ApiError with code, field details and request id', async () => {
    vi.stubGlobal(
      'fetch',
      respond(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Review the highlighted fields.',
          details: [{ path: 'email', message: 'Bad' }],
        },
        meta: { requestId: 'req-42' },
      }),
    );
    const err = await api.post('/users', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Review the highlighted fields.',
      details: [{ path: 'email', message: 'Bad' }],
      requestId: 'req-42',
    });
  });

  it('reports a non-JSON failure generically, keeping the request id header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>Bad gateway</html>', { status: 502, headers: { 'x-request-id': 'gw-1' } }),
      ),
    );
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.requestId).toBe('gw-1');
    expect(err.message).not.toContain('html');
  });

  it('explains a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Cannot reach the server/);
  });

  it('sends the CSRF token from the cookie on state-changing requests only', async () => {
    vi.stubGlobal('document', { cookie: 'other=1; ip_csrf=tok%2Den' });
    const fetchMock = respond(200, { data: null, meta: { requestId: 'r' } });
    vi.stubGlobal('fetch', fetchMock);

    await api.post('/auth/logout');
    await api.get('/auth/me');
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    const headers = (i: number) => calls[i]![1].headers as Record<string, string>;
    expect(headers(0)['x-csrf-token']).toBe('tok-en');
    expect(headers(1)['x-csrf-token']).toBeUndefined();
    expect(calls[0]![0]).toBe('/api/v1/auth/logout');
    expect(calls[0]![1].credentials).toBe('same-origin');
  });
});

describe('messages', () => {
  it('use no dots in keys (next-intl treats dots as nesting)', () => {
    const bad: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k.includes('.')) bad.push(`${path}${k}`);
          walk(v, `${path}${k}/`);
        }
      }
    };
    walk(messages, '');
    expect(bad).toEqual([]);
  });

  it('label every audit action the API records', () => {
    const actions = [
      'auth.login',
      'auth.logout',
      'auth.login_failed',
      'auth.account_locked',
      'auth.mfa_enabled',
      'auth.mfa_verified',
      'user.created',
      'user.roles_changed',
      'user.disabled',
      'user.enabled',
      'user.mfa_reset',
      'property.updated',
      'property.onboarding_completed',
      'tenant.created',
      'room_type.created',
      'room_type.updated',
      'room_type.rate_added',
      'room_type.rate_removed',
      'room.created',
      'room.bulk_created',
      'room.updated',
      'guest.created',
      'guest.updated',
      'guest.document_added',
      'guest.document_removed',
      'guest.document_revealed',
      'reservation.created',
      'reservation.updated',
      'reservation.confirmed',
      'reservation.cancelled',
      'reservation.no_show',
      'reservation.room_assigned',
      'reservation.room_unassigned',
      'reservation.room_changed',
      'reservation.room_added',
      'reservation.room_removed',
    ];
    for (const a of actions) {
      const [group, name] = a.split('.') as [string, string];
      expect((messages.actions as Record<string, Record<string, string>>)[group]?.[name], a).toBeTruthy();
    }
  });

  it('name every role', () => {
    for (const role of ROLE_CODES) expect(messages.roles[role], role).toBeTruthy();
  });
});
