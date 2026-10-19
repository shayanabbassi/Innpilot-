import { z } from 'zod';

export const uuid = z.string().uuid();

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

const timezones: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));
export const timeZone = z
  .string()
  .refine((tz) => timezones.has(tz), { message: 'Choose a valid IANA time zone, e.g. Asia/Karachi.' });

/** 24-hour "HH:MM". */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour time, e.g. 14:00.');

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code.');
