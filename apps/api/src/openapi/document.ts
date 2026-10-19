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
