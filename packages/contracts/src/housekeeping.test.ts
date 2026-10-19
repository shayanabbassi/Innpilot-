import { describe, expect, it } from 'vitest';
import { canTransition, createTicketRequest, outOfOrderInput } from './housekeeping';

describe('housekeeping transitions', () => {
  it('lets a room become clean only by cleaning, and inspected only once clean', () => {
    expect(canTransition('dirty', 'cleaning')).toBe(true);
    expect(canTransition('cleaning', 'clean')).toBe(true);
    expect(canTransition('clean', 'inspected')).toBe(true);
    expect(canTransition('dirty', 'inspected')).toBe(false);
    expect(canTransition('inspected', 'clean')).toBe(false);
    expect(canTransition('clean', 'cleaning')).toBe(false);
  });

  it('always allows going back to dirty', () => {
    for (const from of ['cleaning', 'clean', 'inspected'] as const)
      expect(canTransition(from, 'dirty')).toBe(true);
  });
});

describe('maintenance requests', () => {
  const room = '11111111-1111-4111-8111-111111111111';
  it('needs a room for an out-of-order period and an end after the start', () => {
    expect(
      createTicketRequest.safeParse({
        category: 'plumbing',
        description: 'Leak',
        outOfOrder: { from: '2026-10-19' },
      }).success,
    ).toBe(false);
    expect(
      createTicketRequest.safeParse({
        roomId: room,
        category: 'plumbing',
        description: 'Leak',
        outOfOrder: { from: '2026-10-19' },
      }).success,
    ).toBe(true);
    expect(outOfOrderInput.safeParse({ from: '2026-10-20', to: '2026-10-20' }).success).toBe(false);
  });
});
