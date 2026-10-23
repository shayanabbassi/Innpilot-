import type { ReservationDto } from '@innpilot/contracts';
import { describe, expect, it } from 'vitest';
import { isFree, layoutCalendar } from './calendar';

const ROOM = '11111111-1111-4111-8111-111111111111';
const TYPE = '22222222-2222-4222-8222-222222222222';

function res(
  id: string,
  rooms: { roomId: string | null; arrival: string; departure: string; status?: 'active' | 'released' }[],
): ReservationDto {
  return {
    id,
    bookingReference: 'ABCDEFGH',
    status: 'confirmed',
    source: 'phone',
    notes: null,
    cancelReason: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    arrival: rooms[0]!.arrival,
    departure: rooms[0]!.departure,
    guest: { id: 'g', fullName: `Guest ${id}`, phone: null, email: null, city: null, nationality: null },
    rooms: rooms.map((r, i) => ({
      id: `${id}-${i}`,
      roomTypeId: TYPE,
      roomTypeCode: 'STD',
      roomId: r.roomId,
      roomNumber: r.roomId ? '101' : null,
      arrival: r.arrival,
      departure: r.departure,
      nights: 1,
      adults: 2,
      children: 0,
      nightlyRate: '5000.00',
      currencyCode: 'PKR',
      rateOverridden: false,
      roomTotal: '5000.00',
      status: r.status ?? 'active',
      stayId: null,
    })),
  };
}

describe('layoutCalendar', () => {
  it('places a stay inside the window without drawing the departure night', () => {
    const l = layoutCalendar(
      [res('a', [{ roomId: ROOM, arrival: '2026-10-20', departure: '2026-10-22' }])],
      '2026-10-19',
      7,
    );
    expect(l.days[0]).toBe('2026-10-19');
    expect(l.barsByRoom.get(ROOM)).toEqual([
      expect.objectContaining({ start: 1, span: 2, clippedStart: false, clippedEnd: false }),
    ]);
    expect(isFree(l.barsByRoom.get(ROOM), 3)).toBe(true);
    expect(isFree(l.barsByRoom.get(ROOM), 2)).toBe(false);
  });

  it('clips stays that start before or end after the window', () => {
    const l = layoutCalendar(
      [res('a', [{ roomId: ROOM, arrival: '2026-10-15', departure: '2026-10-30' }])],
      '2026-10-19',
      7,
    );
    expect(l.barsByRoom.get(ROOM)?.[0]).toMatchObject({
      start: 0,
      span: 7,
      clippedStart: true,
      clippedEnd: true,
    });
  });

  it('counts unassigned rooms per night and ignores released or out-of-window ones', () => {
    const l = layoutCalendar(
      [
        res('a', [{ roomId: null, arrival: '2026-10-19', departure: '2026-10-21' }]),
        res('b', [{ roomId: null, arrival: '2026-10-20', departure: '2026-10-21' }]),
        res('c', [{ roomId: null, arrival: '2026-10-19', departure: '2026-10-20', status: 'released' }]),
        res('d', [{ roomId: ROOM, arrival: '2026-11-01', departure: '2026-11-02' }]),
      ],
      '2026-10-19',
      3,
    );
    expect(l.unassignedByType.get(TYPE)).toEqual([1, 2, 0]);
    expect(l.barsByRoom.size).toBe(0);
  });
});
