import type { PropertyDto, RoomDto, RoomTypeDto } from '@innpilot/contracts';

export const ONBOARDING_STEPS = ['business', 'location', 'rooms', 'review'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Required fields per editable step. Together they match ONBOARDING_REQUIRED_FIELDS on the server. */
export const STEP_REQUIRED: Record<'business' | 'location', readonly (keyof PropertyDto)[]> = {
  business: ['name', 'legalName', 'phone'],
  location: ['addressLine', 'city', 'timezone'],
};

function filled(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined;
}

/**
 * Mirrors the server's rule: at least one active room, and a rate in effect for every room type that has
 * active rooms. The server checks again when setup is finished.
 */
export function roomsReady(types: readonly RoomTypeDto[], rooms: readonly RoomDto[]): boolean {
  const active = rooms.filter((r) => r.active);
  if (active.length === 0) return false;
  const used = new Set(active.map((r) => r.roomTypeId));
  return types.filter((t) => used.has(t.id)).every((t) => t.currentRate !== null);
}

/** Where to resume: the first step that is not complete, otherwise the review step. */
export function firstIncompleteStep(property: PropertyDto, hasRooms: boolean): OnboardingStep {
  for (const step of ['business', 'location'] as const) {
    if (!STEP_REQUIRED[step].every((f) => filled(property[f]))) return step;
  }
  return hasRooms ? 'review' : 'rooms';
}
