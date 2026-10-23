import { describe, expect, it } from 'vitest';
import {
  boardState,
  bulkCreateRoomsRequest,
  createRateRequest,
  createRoomTypeRequest,
  expandRoomRange,
  nightlyRate,
} from './rooms';

describe('nightlyRate', () => {
  it.each(['4999', '4999.5', '4999.50', '0.01'])('accepts %s', (v) => {
    expect(nightlyRate.safeParse(v).success).toBe(true);
  });
  it.each(['0', '0.00', '-1', '4999.555', '1e3', '4,999', ''])('rejects %s', (v) => {
    expect(nightlyRate.safeParse(v).success).toBe(false);
  });
  it('rejects a JavaScript number', () => {
    expect(createRateRequest.safeParse({ nightlyRate: 4999 }).success).toBe(false);
  });
});

describe('room type request', () => {
  it('normalises the code to upper case', () => {
    const r = createRoomTypeRequest.parse({
      code: 'dlx',
      name: 'Deluxe',
      capacityAdults: 2,
      capacityChildren: 1,
    });
    expect(r.code).toBe('DLX');
  });
  it('validates real dates for rates', () => {
    expect(createRateRequest.safeParse({ effectiveFrom: '2026-02-30', nightlyRate: '10' }).success).toBe(
      false,
    );
    expect(createRateRequest.safeParse({ effectiveFrom: '2028-02-29', nightlyRate: '10' }).success).toBe(
      true,
    );
  });
});

describe('bulk room ranges', () => {
  const type = '11111111-1111-4111-8111-111111111111';

  it('expands numeric ranges, keeping leading-zero width and prefix', () => {
    expect(expandRoomRange({ from: '101', to: '103' })).toEqual(['101', '102', '103']);
    expect(expandRoomRange({ from: '01', to: '03', prefix: 'A-' })).toEqual(['A-01', 'A-02', 'A-03']);
    expect(expandRoomRange({ from: '8', to: '11' })).toEqual(['8', '9', '10', '11']);
  });

  it('rejects reversed, oversized and too-long ranges', () => {
    expect(bulkCreateRoomsRequest.safeParse({ from: '120', to: '101', roomTypeId: type }).success).toBe(
      false,
    );
    expect(bulkCreateRoomsRequest.safeParse({ from: '1', to: '201', roomTypeId: type }).success).toBe(false);
    expect(
      bulkCreateRoomsRequest.safeParse({ from: '101', to: '102', prefix: '-', roomTypeId: type }).success,
    ).toBe(false);
    expect(bulkCreateRoomsRequest.safeParse({ from: '1', to: '200', roomTypeId: type }).success).toBe(true);
  });
});

describe('boardState', () => {
  const base = { active: true, serviceState: 'in_service' as const, housekeepingState: 'clean' as const };
  it('derives the label with out-of-order and inactive taking precedence', () => {
    expect(boardState(base)).toBe('vacant_ready');
    expect(boardState({ ...base, housekeepingState: 'inspected' })).toBe('vacant_ready');
    expect(boardState({ ...base, housekeepingState: 'dirty' })).toBe('vacant_dirty');
    expect(boardState({ ...base, housekeepingState: 'cleaning' })).toBe('cleaning');
    expect(boardState({ ...base, occupied: true, housekeepingState: 'dirty' })).toBe('occupied');
    expect(boardState({ ...base, serviceState: 'out_of_order', occupied: true })).toBe('out_of_order');
    expect(boardState({ ...base, active: false, serviceState: 'out_of_order' })).toBe('inactive');
  });
});
