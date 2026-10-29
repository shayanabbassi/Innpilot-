import { z } from 'zod';

// A missing value reads "Required", as before Zod 4 (whose default is "Invalid input: expected string, received
// undefined"). Schemas' own messages are unaffected. Applies to the API and the web app alike: they share this Zod.
z.config({
  customError: (issue) =>
    issue.code === 'invalid_type' && issue.input === undefined ? 'Required' : undefined,
});

export * from './admin';
export * from './attachments';
export * from './auth';
export * from './cash';
export * from './cashier';
export * from './checkout';
export * from './close';
export * from './common';
export * from './dashboard';
export * from './day-close';
export * from './errors';
export * from './expenses';
export * from './finance';
export * from './folios';
export * from './payments';
export * from './platform';
export * from './guests';
export * from './housekeeping';
export * from './rbac';
export * from './reconciliation';
export * from './reports';
export * from './reservations';
export * from './rooms';
export * from './stays';
export * from './system';
export * from './tax';
/** The Zod instance the contracts are built with; use it when extending or composing these schemas. */
export { z } from 'zod';
