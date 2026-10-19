import type { PropertyDto } from '@innpilot/contracts';

export const ONBOARDING_STEPS = ['business', 'location', 'review'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Required fields per editable step. Together they match ONBOARDING_REQUIRED_FIELDS on the server. */
export const STEP_REQUIRED: Record<Exclude<OnboardingStep, 'review'>, readonly (keyof PropertyDto)[]> = {
  business: ['name', 'legalName', 'phone'],
  location: ['addressLine', 'city', 'timezone'],
};

function filled(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined;
}

/** Where to resume: the first step with a missing required field, otherwise the review step. */
export function firstIncompleteStep(property: PropertyDto): OnboardingStep {
  for (const step of ['business', 'location'] as const) {
    if (!STEP_REQUIRED[step].every((f) => filled(property[f]))) return step;
  }
  return 'review';
}
