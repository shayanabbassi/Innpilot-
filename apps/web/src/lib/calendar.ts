import { addDays, nightsBetween, type ReservationDto, type ReservationStatus } from '@innpilot/contracts';

export interface CalendarBar {
  reservationId: string;
  label: string;
  status: ReservationStatus;
  /** 0-based column of the first visible night. */
  start: number;
  /** Number of visible nights. */
  span: number;
  /** Stay continues before / after the visible window. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface CalendarLayout {
  days: string[];
  barsByRoom: Map<string, CalendarBar[]>;
  /** Room-type id → bookings without a room for each visible night. */
  unassignedByType: Map<string, number[]>;
}

/**
 * Places active booked rooms on a [from, from + days) grid. Assigned rooms become bars on their room's row;
 * unassigned ones are counted per type and night. Stays are half-open, so the departure night is not drawn.
 */
export function layoutCalendar(
  reservations: readonly ReservationDto[],
  from: string,
  days: number,
): CalendarLayout {
  const dayList = Array.from({ length: days }, (_, i) => addDays(from, i));
  const to = addDays(from, days);
  const barsByRoom = new Map<string, CalendarBar[]>();
  const unassignedByType = new Map<string, number[]>();

  for (const res of reservations) {
    for (const seg of res.rooms) {
      if (seg.status !== 'active' || seg.departure <= from || seg.arrival >= to) continue;
      const startDate = seg.arrival < from ? from : seg.arrival;
      const endDate = seg.departure > to ? to : seg.departure;
      const start = nightsBetween(from, startDate);
      const span = nightsBetween(startDate, endDate);
      if (seg.roomId) {
        const list = barsByRoom.get(seg.roomId) ?? [];
        list.push({
          reservationId: res.id,
          label: res.guest.fullName,
          status: res.status,
          start,
          span,
          clippedStart: seg.arrival < from,
          clippedEnd: seg.departure > to,
        });
        barsByRoom.set(seg.roomId, list);
      } else {
        const counts = unassignedByType.get(seg.roomTypeId) ?? Array.from({ length: days }, () => 0);
        for (let i = start; i < start + span; i++) counts[i] = (counts[i] ?? 0) + 1;
        unassignedByType.set(seg.roomTypeId, counts);
      }
    }
  }
  return { days: dayList, barsByRoom, unassignedByType };
}

/** Whether a room is free on a given visible night (used to offer "book this night"). */
export function isFree(bars: readonly CalendarBar[] | undefined, dayIndex: number): boolean {
  return !(bars ?? []).some((b) => dayIndex >= b.start && dayIndex < b.start + b.span);
}
