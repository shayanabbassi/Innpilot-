import { describe, expect, it } from 'vitest';
import { checkInRequest, readinessProblem, walkInRequest } from './stays';

const ready = {
  active: true,
  serviceState: 'in_service' as const,
  housekeepingState: 'clean' as const,
  occupied: false,
};

describe('readinessProblem', () => {
  it('passes clean and inspected rooms', () => {
    expect(readinessProblem(ready)).toBeNull();
    expect(readinessProblem({ ...ready, housekeepingState: 'inspected' })).toBeNull();
  });

  it('reports the most serious problem first', () => {
    expect(readinessProblem({ ...ready, occupied: true, serviceState: 'out_of_order' })).toBe('occupied');
    expect(readinessProblem({ ...ready, serviceState: 'out_of_order', housekeepingState: 'dirty' })).toBe(
      'out_of_order',
    );
    expect(readinessProblem({ ...ready, housekeepingState: 'dirty' })).toBe('dirty');
    expect(readinessProblem({ ...ready, housekeepingState: 'cleaning' })).toBe('cleaning');
    expect(readinessProblem({ ...ready, active: false, occupied: true })).toBe('inactive');
  });
});

describe('stay requests', () => {
  const room = '11111111-1111-4111-8111-111111111111';
  it('needs exactly one of an existing guest or a new guest for a walk-in', () => {
    const base = { roomId: room, departure: '2026-10-21', adults: 1 };
    expect(walkInRequest.safeParse(base).success).toBe(false);
    expect(walkInRequest.safeParse({ ...base, guestId: room }).success).toBe(true);
    expect(walkInRequest.safeParse({ ...base, guest: { fullName: 'Walk In' } }).success).toBe(true);
    expect(walkInRequest.safeParse({ ...base, guestId: room, guest: { fullName: 'X' } }).success).toBe(false);
  });

  it('requires a real reason when overriding readiness', () => {
    expect(checkInRequest.safeParse({ readinessOverrideReason: 'x' }).success).toBe(false);
    expect(checkInRequest.safeParse({ readinessOverrideReason: 'VIP waiting' }).success).toBe(true);
  });
});
