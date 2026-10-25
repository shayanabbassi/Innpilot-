import { z } from 'zod';
import { businessDate } from './reservations';
import { HOUSEKEEPING_STATES, type HousekeepingState } from './rooms';

/**
 * Allowed housekeeping state changes (decision P2-14). A room becomes clean only by being cleaned, and inspected
 * only once clean; any state can go back to dirty (inspection failed, spillage, guest used the room).
 */
export const HOUSEKEEPING_TRANSITIONS: Record<HousekeepingState, readonly HousekeepingState[]> = {
  dirty: ['cleaning', 'clean'],
  cleaning: ['clean', 'dirty'],
  clean: ['inspected', 'dirty'],
  inspected: ['dirty'],
};

export function canTransition(from: HousekeepingState, to: HousekeepingState): boolean {
  return HOUSEKEEPING_TRANSITIONS[from].includes(to);
}

export const TASK_TYPES = ['clean', 'inspect'] as const;
export const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export const TASK_SOURCES = ['manual', 'room_dirty', 'inspection_failed'] as const;

export const setHousekeepingStateRequest = z
  .object({
    state: z.enum(HOUSEKEEPING_STATES),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();
export type SetHousekeepingStateRequest = z.infer<typeof setHousekeepingStateRequest>;

export const createTaskRequest = z
  .object({
    roomId: z.string().uuid(),
    taskType: z.enum(TASK_TYPES),
    assignedUserId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();
export type CreateTaskRequest = z.infer<typeof createTaskRequest>;

export const updateTaskRequest = z
  .object({
    assignedUserId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateTaskRequest = z.infer<typeof updateTaskRequest>;

export const completeTaskRequest = z
  .object({
    /** For inspections: false sends the room back to dirty with a new cleaning task. */
    passed: z.boolean().optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();
export type CompleteTaskRequest = z.infer<typeof completeTaskRequest>;

export const taskListQuery = z.object({
  status: z.enum(['active', ...TASK_STATUSES]).default('active'),
  mine: z.enum(['true', 'false']).default('false'),
});
export type TaskListQuery = z.infer<typeof taskListQuery>;

export const taskDto = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  roomNumber: z.string(),
  floor: z.string().nullable(),
  roomTypeCode: z.string(),
  housekeepingState: z.enum(HOUSEKEEPING_STATES),
  taskType: z.enum(TASK_TYPES),
  status: z.enum(TASK_STATUSES),
  source: z.enum(TASK_SOURCES),
  assignedUserId: z.string().uuid().nullable(),
  assignedName: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type TaskDto = z.infer<typeof taskDto>;

export const staffMemberDto = z.object({ id: z.string().uuid(), fullName: z.string() });
export type StaffMemberDto = z.infer<typeof staffMemberDto>;

// ---------------------------------------------------------------------------------------------------------------
// Maintenance and out-of-order
// ---------------------------------------------------------------------------------------------------------------

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'cancelled'] as const;
export const TICKET_CATEGORIES = [
  'plumbing',
  'electrical',
  'hvac',
  'furniture',
  'appliance',
  'cleaning',
  'other',
] as const;

export const outOfOrderInput = z
  .object({
    from: businessDate,
    /** Exclusive end date; leave out to keep the room out of order until the ticket is resolved. */
    to: businessDate.nullable().optional(),
    /** Needed when the room has bookings assigned in the period; they are unassigned (needs room.out_of_order). */
    overrideReason: z.string().trim().min(3).max(300).optional(),
  })
  .strict()
  .refine((v) => !v.to || v.to > v.from, { path: ['to'], message: 'The end must be after the start.' });

export const createTicketRequest = z
  .object({
    roomId: z.string().uuid().nullable().optional(),
    category: z.enum(TICKET_CATEGORIES),
    priority: z.enum(TICKET_PRIORITIES).default('normal'),
    description: z.string().trim().min(3, 'Describe the problem.').max(1000),
    outOfOrder: outOfOrderInput.optional(),
  })
  .strict()
  .refine((v) => !v.outOfOrder || v.roomId, {
    path: ['roomId'],
    message: 'Choose the room to take out of order.',
  });
export type CreateTicketRequest = z.infer<typeof createTicketRequest>;

export const resolveTicketRequest = z
  .object({ note: z.string().trim().min(3, 'Say what was done.').max(1000) })
  .strict();
export type ResolveTicketRequest = z.infer<typeof resolveTicketRequest>;

export const ticketListQuery = z.object({ status: z.enum(['active', ...TICKET_STATUSES]).default('active') });
export type TicketListQuery = z.infer<typeof ticketListQuery>;

export const ticketDto = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid().nullable(),
  roomNumber: z.string().nullable(),
  category: z.enum(TICKET_CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES),
  status: z.enum(TICKET_STATUSES),
  description: z.string(),
  outOfOrderFrom: z.string().nullable(),
  outOfOrderTo: z.string().nullable(),
  reportedByName: z.string().nullable(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  resolutionNote: z.string().nullable(),
  /** Bookings that lost their room assignment because of this out-of-order period. */
  unassignedBookings: z.array(z.object({ reservationId: z.string().uuid(), bookingReference: z.string() })),
});
export type TicketDto = z.infer<typeof ticketDto>;
