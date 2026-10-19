import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import {
  auditEventDto,
  auditEventsQuery,
  createUserRequest,
  CSRF_HEADER,
  ERROR_CODES,
  loginRequest,
  loginResponse,
  meResponse,
  mfaCodeRequest,
  mfaSetupResponse,
  propertyDto,
  reasonRequest,
  setUserRolesRequest,
  setUserStatusRequest,
  updatePropertyRequest,
  userDto,
  bulkCreateRoomsRequest,
  createRateRequest,
  createRoomRequest,
  createRoomTypeRequest,
  roomBoardDto,
  roomDto,
  roomTypeDto,
  roomTypeRateDto,
  updateRoomRequest,
  updateRoomTypeRequest,
  createGuestRequest,
  duplicateCandidateDto,
  duplicateCheckRequest,
  guestDocumentInput,
  guestDto,
  guestSearchQuery,
  guestSummaryDto,
  revealedDocumentDto,
  revealRequest,
  updateGuestRequest,
  assignRoomRequest,
  availabilityDto,
  availabilityQueryObject,
  cancelReservationRequest,
  createReservationRequest,
  noShowRequest,
  reservationDto,
  reservationListQueryObject,
  reservationRoomInput,
  updateReservationRequest,
  checkInRequest,
  frontDeskTodayDto,
  moveRoomRequest,
  stayDto,
  walkInRequest,
  completeTaskRequest,
  createTaskRequest,
  createTicketRequest,
  resolveTicketRequest,
  setHousekeepingStateRequest,
  staffMemberDto,
  taskDto,
  taskListQuery,
  ticketDto,
  ticketListQuery,
  updateTaskRequest,
  z,
} from '@innpilot/contracts';
import type { ZodTypeAny } from 'zod';
import { collectRoutes, describePolicy } from './routes';

// Adds .openapi() to Zod's prototype, which the generator uses for parameters. Applies to schemas already
// created in @innpilot/contracts because they share this Zod instance.
extendZodWithOpenApi(z);

interface RouteDoc {
  summary: string;
  tag: string;
  body?: ZodTypeAny;
  query?: z.AnyZodObject;
  /** `null` for commands that return no data. */
  data: ZodTypeAny | null;
  paged?: boolean;
  status?: number;
}

/** Every {placeholder} in our paths is a UUID. */
function pathParams(path: string) {
  const names = [...path.matchAll(/{(w+)}/g)].map((m) => m[1]!);
  return names.length ? z.object(Object.fromEntries(names.map((n) => [n, z.string().uuid()]))) : undefined;
}

/** Documentation for every route. A test fails if a route is missing here or listed but not implemented. */
export const ROUTE_DOCS: Record<string, RouteDoc> = {
  'POST /auth/login': {
    tag: 'Auth',
    summary: 'Sign in with email and password',
    body: loginRequest,
    data: loginResponse,
    status: 200,
  },
  'POST /auth/logout': { tag: 'Auth', summary: 'End the current session', data: null, status: 200 },
  'GET /auth/me': {
    tag: 'Auth',
    summary: 'Current user, tenant, session state and property access',
    data: meResponse,
  },
  'POST /auth/mfa/setup': {
    tag: 'Auth',
    summary: 'Start two-step verification enrolment',
    data: mfaSetupResponse,
    status: 200,
  },
  'POST /auth/mfa/enable': {
    tag: 'Auth',
    summary: 'Confirm enrolment with a first code',
    body: mfaCodeRequest,
    data: null,
    status: 200,
  },
  'POST /auth/mfa/verify': {
    tag: 'Auth',
    summary: 'Complete sign-in with a code',
    body: mfaCodeRequest,
    data: null,
    status: 200,
  },
  'GET /properties': {
    tag: 'Properties',
    summary: 'Properties the caller can see',
    data: z.array(propertyDto),
  },
  'GET /properties/{id}': { tag: 'Properties', summary: 'Property profile and settings', data: propertyDto },
  'PATCH /properties/{id}': {
    tag: 'Properties',
    summary: 'Change property settings (audited)',
    body: updatePropertyRequest,
    data: propertyDto,
  },
  'POST /properties/{id}/onboarding/complete': {
    tag: 'Properties',
    summary: 'Finish the setup wizard (checks required details)',
    data: propertyDto,
    status: 200,
  },
  'GET /properties/{propertyId}/room-types': {
    tag: 'Rooms',
    summary: 'Room types with room counts and the rate in effect on the business date',
    data: z.array(roomTypeDto),
  },
  'POST /properties/{propertyId}/room-types': {
    tag: 'Rooms',
    summary: 'Create a room type, optionally with its first rate',
    body: createRoomTypeRequest,
    data: roomTypeDto,
    status: 201,
  },
  'PATCH /properties/{propertyId}/room-types/{id}': {
    tag: 'Rooms',
    summary: 'Change a room type (cannot deactivate while it has active rooms)',
    body: updateRoomTypeRequest,
    data: roomTypeDto,
  },
  'GET /properties/{propertyId}/room-types/{id}/rates': {
    tag: 'Rooms',
    summary: 'Rate history, newest first',
    data: z.array(roomTypeRateDto),
  },
  'POST /properties/{propertyId}/room-types/{id}/rates': {
    tag: 'Rooms',
    summary: 'Add a base nightly rate from a date (not before the business date)',
    body: createRateRequest,
    data: roomTypeRateDto,
    status: 201,
  },
  'DELETE /properties/{propertyId}/room-types/{id}/rates/{rateId}': {
    tag: 'Rooms',
    summary: 'Remove a rate that has not taken effect yet',
    data: null,
  },
  'GET /properties/{propertyId}/rooms': {
    tag: 'Rooms',
    summary: 'All rooms of the property',
    data: z.array(roomDto),
  },
  'POST /properties/{propertyId}/rooms': {
    tag: 'Rooms',
    summary: 'Add one room',
    body: createRoomRequest,
    data: roomDto,
    status: 201,
  },
  'POST /properties/{propertyId}/rooms/bulk': {
    tag: 'Rooms',
    summary: 'Add a numbered range of rooms (all or nothing, up to 200)',
    body: bulkCreateRoomsRequest,
    data: z.array(roomDto),
    status: 201,
  },
  'PATCH /properties/{propertyId}/rooms/{id}': {
    tag: 'Rooms',
    summary: 'Change room number, floor, type or active flag',
    body: updateRoomRequest,
    data: roomDto,
  },
  'GET /properties/{propertyId}/room-board': {
    tag: 'Rooms',
    summary: 'Read-only room board with derived status labels and counts',
    data: roomBoardDto,
  },
  'GET /guests': {
    tag: 'Guests',
    summary: 'Search guests by name (fuzzy), phone or email. Never returns identity-document data.',
    query: guestSearchQuery,
    data: z.array(guestSummaryDto),
  },
  'POST /guests/duplicate-check': {
    tag: 'Guests',
    summary: 'Find likely existing profiles (same phone, email or document; similar name)',
    body: duplicateCheckRequest,
    data: z.array(duplicateCandidateDto),
    status: 200,
  },
  'POST /guests': {
    tag: 'Guests',
    summary: 'Create a guest, optionally with a first identity document (needs guest.identity.read)',
    body: createGuestRequest,
    data: guestDto,
    status: 201,
  },
  'GET /guests/{id}': {
    tag: 'Guests',
    summary: 'Guest profile. Documents (masked) only for guest.identity.read holders.',
    data: guestDto,
  },
  'PATCH /guests/{id}': {
    tag: 'Guests',
    summary: 'Change a guest profile (audit records field names only)',
    body: updateGuestRequest,
    data: guestDto,
  },
  'POST /guests/{id}/documents': {
    tag: 'Guests',
    summary: 'Add an identity document; the number is stored encrypted (also needs guest.identity.read)',
    body: guestDocumentInput,
    data: guestDto,
    status: 201,
  },
  'DELETE /guests/{id}/documents/{documentId}': {
    tag: 'Guests',
    summary: 'Remove an identity document (also needs guest.identity.read)',
    data: guestDto,
  },
  'POST /guests/{id}/documents/{documentId}/reveal': {
    tag: 'Guests',
    summary: 'Show one full document number; a reason is required and the reveal is audited',
    body: revealRequest,
    data: revealedDocumentDto,
    status: 200,
  },
  'GET /properties/{propertyId}/availability': {
    tag: 'Reservations',
    summary: 'Rooms left per type for every night of a range, free rooms and rate (advisory)',
    query: availabilityQueryObject,
    data: availabilityDto,
  },
  'GET /properties/{propertyId}/reservations': {
    tag: 'Reservations',
    summary: 'Bookings overlapping a date range, by status or reference/guest search',
    query: reservationListQueryObject,
    data: z.array(reservationDto),
  },
  'POST /properties/{propertyId}/reservations': {
    tag: 'Reservations',
    summary: 'Create a booking. Requires Idempotency-Key. 409 ROOM_UNAVAILABLE if any night is full.',
    body: createReservationRequest,
    data: reservationDto,
    status: 201,
  },
  'GET /properties/{propertyId}/reservations/{id}': {
    tag: 'Reservations',
    summary: 'One booking',
    data: reservationDto,
  },
  'GET /properties/{propertyId}/reservations/{id}/history': {
    tag: 'Reservations',
    summary: 'Change history of a booking (from the audit log)',
    data: z.array(auditEventDto),
  },
  'PATCH /properties/{propertyId}/reservations/{id}': {
    tag: 'Reservations',
    summary: 'Change source or notes',
    body: updateReservationRequest,
    data: reservationDto,
  },
  'POST /properties/{propertyId}/reservations/{id}/confirm': {
    tag: 'Reservations',
    summary: 'Confirm a pending booking',
    data: reservationDto,
    status: 200,
  },
  'POST /properties/{propertyId}/reservations/{id}/cancel': {
    tag: 'Reservations',
    summary: 'Cancel with a reason; releases the rooms',
    body: cancelReservationRequest,
    data: reservationDto,
    status: 200,
  },
  'POST /properties/{propertyId}/reservations/{id}/no-show': {
    tag: 'Reservations',
    summary: 'Mark a no-show (not before the arrival date); releases the rooms',
    body: noShowRequest,
    data: reservationDto,
    status: 200,
  },
  'POST /properties/{propertyId}/reservations/{id}/rooms': {
    tag: 'Reservations',
    summary: 'Add a room to a booking',
    body: reservationRoomInput,
    data: reservationDto,
    status: 201,
  },
  'PUT /properties/{propertyId}/reservations/{id}/rooms/{roomId}': {
    tag: 'Reservations',
    summary: 'Change dates, type, room or guests of a booked room (agreed rate kept unless the type changes)',
    body: reservationRoomInput,
    data: reservationDto,
  },
  'POST /properties/{propertyId}/reservations/{id}/rooms/{roomId}/assign': {
    tag: 'Reservations',
    summary: 'Assign or unassign a specific room',
    body: assignRoomRequest,
    data: reservationDto,
    status: 200,
  },
  'DELETE /properties/{propertyId}/reservations/{id}/rooms/{roomId}': {
    tag: 'Reservations',
    summary: 'Remove a room from a multi-room booking',
    data: reservationDto,
  },
  'GET /properties/{propertyId}/front-desk/today': {
    tag: 'Front desk',
    summary: 'Arrivals due (with room readiness), in-house guests and departures for the business date',
    data: frontDeskTodayDto,
  },
  'POST /properties/{propertyId}/reservations/{id}/rooms/{roomId}/check-in': {
    tag: 'Front desk',
    summary:
      'Check in one booked room. Requires Idempotency-Key. 409 ROOM_NOT_READY unless the room is ready or a manager overrides with a reason.',
    body: checkInRequest,
    data: stayDto,
    status: 200,
  },
  'POST /properties/{propertyId}/walk-ins': {
    tag: 'Front desk',
    summary: 'Create guest (optional), booking and check-in in one step. Requires Idempotency-Key.',
    body: walkInRequest,
    data: stayDto,
    status: 201,
  },
  'GET /properties/{propertyId}/stays/{stayId}': {
    tag: 'Front desk',
    summary: 'One stay with room history',
    data: stayDto,
  },
  'POST /properties/{propertyId}/stays/{stayId}/move': {
    tag: 'Front desk',
    summary: 'Move an in-house guest to another room from today (old room becomes dirty)',
    body: moveRoomRequest,
    data: stayDto,
    status: 200,
  },
  'POST /properties/{propertyId}/rooms/{roomId}/housekeeping-state': {
    tag: 'Housekeeping',
    summary: 'Change a room housekeeping state (allowed transitions only)',
    body: setHousekeepingStateRequest,
    data: z.object({ id: z.string().uuid(), housekeepingState: z.string() }),
    status: 200,
  },
  'GET /properties/{propertyId}/housekeeping/tasks': {
    tag: 'Housekeeping',
    summary: 'Cleaning and inspection tasks (no guest data)',
    query: taskListQuery,
    data: z.array(taskDto),
  },
  'GET /properties/{propertyId}/housekeeping/staff': {
    tag: 'Housekeeping',
    summary: 'Staff who can be assigned housekeeping tasks',
    data: z.array(staffMemberDto),
  },
  'POST /properties/{propertyId}/housekeeping/tasks': {
    tag: 'Housekeeping',
    summary: 'Create a cleaning or inspection task (one open task per type per room)',
    body: createTaskRequest,
    data: taskDto,
    status: 201,
  },
  'PATCH /properties/{propertyId}/housekeeping/tasks/{id}': {
    tag: 'Housekeeping',
    summary: 'Assign a task or change its notes',
    body: updateTaskRequest,
    data: taskDto,
  },
  'POST /properties/{propertyId}/housekeeping/tasks/{id}/start': {
    tag: 'Housekeeping',
    summary: 'Start a task (cleaning marks the room as being cleaned)',
    data: taskDto,
    status: 200,
  },
  'POST /properties/{propertyId}/housekeeping/tasks/{id}/complete': {
    tag: 'Housekeeping',
    summary: 'Finish a task: cleaning → clean; inspection passed → inspected, failed → dirty with a new task',
    body: completeTaskRequest,
    data: taskDto,
    status: 200,
  },
  'POST /properties/{propertyId}/housekeeping/tasks/{id}/cancel': {
    tag: 'Housekeeping',
    summary: 'Cancel a task that is no longer needed',
    data: taskDto,
    status: 200,
  },
  'GET /properties/{propertyId}/maintenance/tickets': {
    tag: 'Housekeeping',
    summary: 'Maintenance tickets, most urgent first',
    query: ticketListQuery,
    data: z.array(ticketDto),
  },
  'POST /properties/{propertyId}/maintenance/tickets': {
    tag: 'Housekeeping',
    summary:
      'Report a problem; optionally take the room out of order for a dated period (room.out_of_order). Refused if a guest is in the room or the type would be overbooked.',
    body: createTicketRequest,
    data: ticketDto,
    status: 201,
  },
  'POST /properties/{propertyId}/maintenance/tickets/{id}/start': {
    tag: 'Housekeeping',
    summary: 'Mark a ticket as being worked on',
    data: ticketDto,
    status: 200,
  },
  'POST /properties/{propertyId}/maintenance/tickets/{id}/resolve': {
    tag: 'Housekeeping',
    summary: 'Resolve a ticket; ends its out-of-order period and returns the room to service',
    body: resolveTicketRequest,
    data: ticketDto,
    status: 200,
  },
  'GET /users': { tag: 'Staff', summary: 'Staff accounts and role assignments', data: z.array(userDto) },
  'POST /users': {
    tag: 'Staff',
    summary: 'Create a staff account',
    body: createUserRequest,
    data: userDto,
    status: 201,
  },
  'PUT /users/{id}/roles': {
    tag: 'Staff',
    summary: "Replace a user's role assignments",
    body: setUserRolesRequest,
    data: userDto,
  },
  'POST /users/{id}/status': {
    tag: 'Staff',
    summary: 'Disable or re-enable an account',
    body: setUserStatusRequest,
    data: userDto,
    status: 200,
  },
  'POST /users/{id}/mfa/reset': {
    tag: 'Staff',
    summary: 'Reset two-step verification after a lost device',
    body: reasonRequest,
    data: userDto,
    status: 200,
  },
  'GET /audit-events': {
    tag: 'Audit',
    summary: 'Audit log, newest first',
    query: auditEventsQuery,
    data: auditEventDto,
    paged: true,
  },
  'GET /health': {
    tag: 'Operations',
    summary: 'Liveness and database reachability',
    data: z.object({ status: z.literal('ok') }),
  },
};

const errorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
  meta: z.object({ requestId: z.string() }),
});

function successBody(data: ZodTypeAny | null, paged: boolean): ZodTypeAny {
  return z.object({
    data: paged && data ? z.array(data) : (data ?? z.null()),
    meta: paged
      ? z.object({ requestId: z.string(), nextCursor: z.string().nullable() })
      : z.object({ requestId: z.string() }),
  });
}

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: '__Host-ip_session',
    description: `Session cookie set by POST /auth/login. State-changing requests must also send the \`${CSRF_HEADER}\` header with the value of the \`__Host-ip_csrf\` cookie.`,
  });

  for (const route of collectRoutes()) {
    const doc = ROUTE_DOCS[route.key];
    if (!doc || !route.policy) continue;
    const status = doc.status ?? 200;
    const config: RouteConfig = {
      method: route.method.toLowerCase() as RouteConfig['method'],
      path: route.path,
      tags: [doc.tag],
      summary: doc.summary,
      description: describePolicy(route.policy),
      security: route.policy.kind === 'public' ? [] : [{ session: [] }],
      request: {
        ...(pathParams(route.path) ? { params: pathParams(route.path)! } : {}),
        ...(doc.query ? { query: doc.query } : {}),
        ...(doc.body ? { body: { content: { 'application/json': { schema: doc.body } } } } : {}),
      },
      responses: {
        [status]: {
          description: 'Success',
          content: { 'application/json': { schema: successBody(doc.data, doc.paged ?? false) } },
        },
        default: {
          description: 'Error. `code` is stable and machine-readable; `message` is safe to show to users.',
          content: { 'application/json': { schema: errorBody } },
        },
      },
    };
    registry.registerPath(config);
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'InnPilot API',
      version: '1.0.0',
      description:
        'Hotel operations and finance API. All amounts are decimal strings. Tenant and property scope always come from the session, never from request data.',
    },
    servers: [{ url: '/api/v1' }],
  });
}
