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
  accountDto,
  checkOutRequest,
  checkOutResultDto,
  checkoutPreviewDto,
  invoiceDto,
  cashAccountDto,
  cashMovementsDto,
  cardSettlementDto,
  cardSettlementRequest,
  completeReconciliationRequest,
  reconciliationDetailDto,
  reconciliationDto,
  reconciliationItemsRequest,
  reconciliationListQueryObject,
  startReconciliationRequest,
  updateReconciliationRequest,
  createSupplierRequest,
  expenseAccountDto,
  expenseDraftRequest,
  expenseDto,
  expenseListQueryObject,
  payExpenseRequest,
  submitExpenseRequest,
  supplierDto,
  updateSupplierRequest,
  voidExpenseRequest,
  approveClosingRequest,
  cashierShiftDetailDto,
  cashierShiftDto,
  openShiftRequest,
  reopenClosingRequest,
  shiftListQueryObject,
  submitClosingRequest,
  cashMovementsQueryObject,
  createCashAccountRequest,
  openingBalancesDto,
  openingBalancesRequest,
  transferDto,
  transferListQueryObject,
  transferRequest,
  updateCashAccountRequest,
  paymentDto,
  paymentListQueryObject,
  receiptDto,
  recordPaymentRequest,
  refundRequest,
  createFolioRequest,
  folioDto,
  openFolioDto,
  postAllowanceRequest,
  postChargeRequest,
  transferChargeRequest,
  voidChargeRequest,
  chargeCategoryDto,
  createChargeCategoryRequest,
  createTaxCodeRequest,
  invoiceProfileDto,
  invoiceProfileRequest,
  taxCodeDto,
  taxPreviewDto,
  taxPreviewRequest,
  taxRateInput,
  updateChargeCategoryRequest,
  updateTaxCodeRequest,
  createAccountRequest,
  dayCloseDto,
  fiscalPeriodDto,
  journalDraftRequest,
  journalEntryDto,
  journalListDto,
  journalListQueryObject,
  ledgerDto,
  ledgerQueryObject,
  reopenPeriodRequest,
  reverseJournalRequest,
  trialBalanceDto,
  trialBalanceQueryObject,
  updateAccountRequest,
  dayClosePreviewDto,
  dayCloseRequest,
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
  'GET /properties/{propertyId}/day-close/preview': {
    tag: 'Day close',
    summary: 'What is still open for the business date, and out-of-order changes for the next date',
    data: dayClosePreviewDto,
  },
  'GET /properties/{propertyId}/day-close/history': {
    tag: 'Day close',
    summary: 'Last 30 closed business dates',
    data: z.array(dayCloseDto),
  },
  'POST /properties/{propertyId}/day-close': {
    tag: 'Day close',
    summary:
      'Close the business date once (Idempotency-Key): optional no-show marking, a reason if items remain, then the date advances by one day',
    body: dayCloseRequest,
    data: dayCloseDto,
    status: 200,
  },
  'GET /properties/{propertyId}/tax-codes': {
    tag: 'Taxes and charges',
    summary: 'Tax codes with their rate history and the rate in effect today',
    data: z.array(taxCodeDto),
  },
  'POST /properties/{propertyId}/tax-codes': {
    tag: 'Taxes and charges',
    summary: 'Add a tax code with its first rate (not before the business date)',
    body: createTaxCodeRequest,
    data: taxCodeDto,
    status: 201,
  },
  'PATCH /properties/{propertyId}/tax-codes/{id}': {
    tag: 'Taxes and charges',
    summary: 'Rename, re-map or (de)activate a tax code',
    body: updateTaxCodeRequest,
    data: taxCodeDto,
  },
  'POST /properties/{propertyId}/tax-codes/{id}/rates': {
    tag: 'Taxes and charges',
    summary: 'Add a rate from a date on or after the business date (rates are never edited)',
    body: taxRateInput,
    data: taxCodeDto,
    status: 201,
  },
  'DELETE /properties/{propertyId}/tax-codes/{id}/rates/{rateId}': {
    tag: 'Taxes and charges',
    summary: 'Remove a rate that has not taken effect yet',
    data: taxCodeDto,
    status: 200,
  },
  'GET /properties/{propertyId}/charge-categories': {
    tag: 'Taxes and charges',
    summary: 'Charge categories with their revenue account and default tax codes',
    data: z.array(chargeCategoryDto),
  },
  'POST /properties/{propertyId}/charge-categories': {
    tag: 'Taxes and charges',
    summary: 'Add a charge category',
    body: createChargeCategoryRequest,
    data: chargeCategoryDto,
    status: 201,
  },
  'PATCH /properties/{propertyId}/charge-categories/{id}': {
    tag: 'Taxes and charges',
    summary: 'Change a category: name, revenue account, tax codes, active (the room category stays active)',
    body: updateChargeCategoryRequest,
    data: chargeCategoryDto,
  },
  'POST /properties/{propertyId}/tax-preview': {
    tag: 'Taxes and charges',
    summary: 'Calculate net, taxes and gross for an amount in a category on a date (nothing is saved)',
    body: taxPreviewRequest,
    data: taxPreviewDto,
    status: 200,
  },
  'GET /properties/{propertyId}/invoice-profile': {
    tag: 'Taxes and charges',
    summary: 'What prints on invoices and receipts',
    data: invoiceProfileDto,
  },
  'PUT /properties/{propertyId}/invoice-profile': {
    tag: 'Taxes and charges',
    summary: 'Replace the invoice details (registration fields are label/value pairs)',
    body: invoiceProfileRequest,
    data: invoiceProfileDto,
  },
  'GET /properties/{propertyId}/reservations/{reservationId}/folios': {
    tag: 'Folios',
    summary: 'Folios of a reservation, main first, with items, balance and pending room nights',
    data: z.array(folioDto),
  },
  'POST /properties/{propertyId}/reservations/{reservationId}/folios': {
    tag: 'Folios',
    summary: 'Open an extra folio for split billing (the main folio opens at check-in)',
    body: createFolioRequest,
    data: folioDto,
    status: 201,
  },
  'GET /properties/{propertyId}/folios': {
    tag: 'Folios',
    summary: 'Open folios of the property, for transfers',
    data: z.array(openFolioDto),
  },
  'GET /properties/{propertyId}/folios/{id}': { tag: 'Folios', summary: 'One folio', data: folioDto },
  'POST /properties/{propertyId}/folios/{id}/charges': {
    tag: 'Folios',
    summary:
      'Post a charge with its tax snapshot and journal (Idempotency-Key); room nights post at check-out',
    body: postChargeRequest,
    data: folioDto,
    status: 201,
  },
  'POST /properties/{propertyId}/folios/{id}/allowances': {
    tag: 'Folios',
    summary: 'Post a discount or correction with a reason (Idempotency-Key, folio.adjust)',
    body: postAllowanceRequest,
    data: folioDto,
    status: 201,
  },
  'POST /properties/{propertyId}/folio-charges/{id}/void': {
    tag: 'Folios',
    summary: 'Void an item: its journal is reversed exactly; the item stays, marked voided (folio.adjust)',
    body: voidChargeRequest,
    data: folioDto,
    status: 200,
  },
  'POST /properties/{propertyId}/folio-charges/{id}/transfer': {
    tag: 'Folios',
    summary: 'Move an item to another open folio; the receivable moves with it (folio.adjust)',
    body: transferChargeRequest,
    data: folioDto,
    status: 200,
  },
  'GET /properties/{propertyId}/cash-accounts': {
    tag: 'Cash and bank',
    summary:
      'Cash drawers, bank and card accounts, with balances from the ledger (balance needs journal.read)',
    data: z.array(cashAccountDto),
  },
  'POST /properties/{propertyId}/cash-accounts': {
    tag: 'Cash and bank',
    summary:
      'Add a cash drawer or bank account (posts to the system account for its kind unless one is chosen)',
    body: createCashAccountRequest,
    data: cashAccountDto,
    status: 201,
  },
  'PATCH /properties/{propertyId}/cash-accounts/{id}': {
    tag: 'Cash and bank',
    summary: 'Rename, change details, or close an account (only when its balance is zero)',
    body: updateCashAccountRequest,
    data: cashAccountDto,
  },
  'GET /properties/{propertyId}/cash-accounts/{id}/movements': {
    tag: 'Cash and bank',
    summary: 'Money in and out of one account with a running balance, read from the posted journal lines',
    query: cashMovementsQueryObject,
    data: cashMovementsDto,
  },
  'GET /properties/{propertyId}/transfers': {
    tag: 'Cash and bank',
    summary: 'Transfers between cash and bank accounts, newest first',
    query: transferListQueryObject,
    data: z.array(transferDto),
  },
  'POST /properties/{propertyId}/transfers': {
    tag: 'Cash and bank',
    summary:
      'Move money between two accounts (Idempotency-Key): one journal, never revenue or expense; a drawer cannot go below zero',
    body: transferRequest,
    data: transferDto,
    status: 201,
  },
  'GET /properties/{propertyId}/opening-balances': {
    tag: 'Cash and bank',
    summary: 'The opening balances entry of the property, or null before it is entered',
    data: openingBalancesDto.nullable(),
  },
  'POST /properties/{propertyId}/opening-balances': {
    tag: 'Cash and bank',
    summary:
      'Enter the opening balances once (Idempotency-Key, journal.post): balance sheet accounts, difference to opening balance equity',
    body: openingBalancesRequest,
    data: openingBalancesDto,
    status: 201,
  },
  'GET /properties/{propertyId}/cashier-shifts/current': {
    tag: 'Cashier shifts',
    summary: 'Your open shift on this property with live expected cash, or null',
    data: cashierShiftDto.nullable(),
  },
  'GET /properties/{propertyId}/cashier-shifts': {
    tag: 'Cashier shifts',
    summary: "Shifts, newest first: everyone's for supervisors and ledger readers, otherwise your own",
    query: shiftListQueryObject,
    data: z.array(cashierShiftDto),
  },
  'GET /properties/{propertyId}/cashier-shifts/{id}': {
    tag: 'Cashier shifts',
    summary: 'One shift with its cash movements and closings',
    data: cashierShiftDetailDto,
  },
  'POST /properties/{propertyId}/cashier-shifts/open': {
    tag: 'Cashier shifts',
    summary:
      'Open a shift on a cash drawer with the opening count (Idempotency-Key); one per cashier and drawer',
    body: openShiftRequest,
    data: cashierShiftDto,
    status: 201,
  },
  'POST /properties/{propertyId}/cashier-shifts/{id}/submit-closing': {
    tag: 'Cashier shifts',
    summary:
      'Close your shift with the counted cash (Idempotency-Key): variance needs an explanation; above the threshold it waits for approval; 409 CASH_CLOSING_ALREADY_SUBMITTED',
    body: submitClosingRequest,
    data: cashierShiftDto,
    status: 200,
  },
  'POST /properties/{propertyId}/cashier-shifts/{id}/approve-closing': {
    tag: 'Cashier shifts',
    summary:
      'Approve a closing (cashier.approve, not the submitter); posts the variance to cash over and short',
    body: approveClosingRequest,
    data: cashierShiftDto,
    status: 200,
  },
  'POST /properties/{propertyId}/cashier-shifts/{id}/reopen': {
    tag: 'Cashier shifts',
    summary:
      'Reopen a closing (cashier.reopen, reason): the variance entry is reversed and the shift opens again',
    body: reopenClosingRequest,
    data: cashierShiftDto,
    status: 200,
  },
  'GET /suppliers': {
    tag: 'Expenses',
    summary: 'Suppliers with what each is owed (from their accounts payable lines) and open bills',
    data: z.array(supplierDto),
  },
  'POST /suppliers': {
    tag: 'Expenses',
    summary: 'Add a supplier (supplier.manage)',
    body: createSupplierRequest,
    data: supplierDto,
    status: 201,
  },
  'PATCH /suppliers/{id}': {
    tag: 'Expenses',
    summary: 'Change or deactivate a supplier (suppliers are never deleted)',
    body: updateSupplierRequest,
    data: supplierDto,
  },
  'GET /properties/{propertyId}/expenses': {
    tag: 'Expenses',
    summary:
      'Expenses and bills, newest first (only your own without expense.approve, expense.pay or journal.read)',
    query: expenseListQueryObject,
    data: z.array(expenseDto),
  },
  'GET /properties/{propertyId}/expenses/accounts': {
    tag: 'Expenses',
    summary: 'Accounts an expense line can use (expense, cost of sales, non-cash assets)',
    data: z.array(expenseAccountDto),
  },
  'GET /properties/{propertyId}/expenses/{id}': {
    tag: 'Expenses',
    summary: 'One expense or bill with its lines and payments',
    data: expenseDto,
  },
  'POST /properties/{propertyId}/expenses': {
    tag: 'Expenses',
    summary: 'Record a draft cash expense or supplier bill (Idempotency-Key)',
    body: expenseDraftRequest,
    data: expenseDto,
    status: 201,
  },
  'PUT /properties/{propertyId}/expenses/{id}': {
    tag: 'Expenses',
    summary: 'Replace a draft; refused once submitted',
    body: expenseDraftRequest,
    data: expenseDto,
  },
  'POST /properties/{propertyId}/expenses/{id}/submit': {
    tag: 'Expenses',
    summary:
      'Submit (Idempotency-Key): a cash expense is paid and posted now (Dr expense, Cr cash); a bill goes for approval',
    body: submitExpenseRequest,
    data: expenseDto,
    status: 200,
  },
  'POST /properties/{propertyId}/expenses/{id}/approve': {
    tag: 'Expenses',
    summary:
      'Approve a bill into payables (Dr expense, Cr accounts payable) or review a paid cash expense; never your own (Idempotency-Key)',
    data: expenseDto,
    status: 200,
  },
  'POST /properties/{propertyId}/expenses/{id}/pay': {
    tag: 'Expenses',
    summary:
      'Pay part or all of an approved bill (Idempotency-Key, expense.pay): Dr accounts payable, Cr cash or bank; 422 PAYMENT_EXCEEDS_BALANCE',
    body: payExpenseRequest,
    data: expenseDto,
    status: 201,
  },
  'POST /properties/{propertyId}/expenses/{id}/void': {
    tag: 'Expenses',
    summary:
      'Void with a reason; anything posted is reversed (expense.approve); bills with payments cannot be voided',
    body: voidExpenseRequest,
    data: expenseDto,
    status: 200,
  },
  'GET /properties/{propertyId}/reconciliations': {
    tag: 'Bank reconciliation',
    summary: 'Reconciliations of bank and card accounts, latest statement first',
    query: reconciliationListQueryObject,
    data: z.array(reconciliationDto),
  },
  'GET /properties/{propertyId}/reconciliations/{id}': {
    tag: 'Bank reconciliation',
    summary:
      'One reconciliation with its ticked lines and (in progress) the unreconciled lines to the statement date',
    data: reconciliationDetailDto,
  },
  'POST /properties/{propertyId}/reconciliations': {
    tag: 'Bank reconciliation',
    summary: 'Start a reconciliation for a statement (bank.reconcile); one in progress per account',
    body: startReconciliationRequest,
    data: reconciliationDetailDto,
    status: 201,
  },
  'PATCH /properties/{propertyId}/reconciliations/{id}': {
    tag: 'Bank reconciliation',
    summary: 'Change the statement date or balance while in progress',
    body: updateReconciliationRequest,
    data: reconciliationDetailDto,
  },
  'PUT /properties/{propertyId}/reconciliations/{id}/items': {
    tag: 'Bank reconciliation',
    summary: 'Replace the ticked ledger lines; a line can be reconciled only once',
    body: reconciliationItemsRequest,
    data: reconciliationDetailDto,
  },
  'POST /properties/{propertyId}/reconciliations/{id}/complete': {
    tag: 'Bank reconciliation',
    summary:
      'Finish (Idempotency-Key): the difference must be zero or explained; the reconciliation and its lines are then locked',
    body: completeReconciliationRequest,
    data: reconciliationDetailDto,
    status: 200,
  },
  'DELETE /properties/{propertyId}/reconciliations/{id}': {
    tag: 'Bank reconciliation',
    summary: 'Abandon a reconciliation still in progress',
    data: z.object({ id: z.string() }),
    status: 200,
  },
  'GET /properties/{propertyId}/card-settlements': {
    tag: 'Cash and bank',
    summary: 'Card settlements, newest first',
    data: z.array(cardSettlementDto),
  },
  'POST /properties/{propertyId}/card-settlements': {
    tag: 'Cash and bank',
    summary:
      'Record a card settlement (Idempotency-Key, cash.transfer): Dr bank (net), Dr bank charges (fee), Cr card clearing (gross)',
    body: cardSettlementRequest,
    data: cardSettlementDto,
    status: 201,
  },
  'GET /properties/{propertyId}/payments': {
    tag: 'Payments',
    summary: 'Payments and deposits, newest first, with their refunds',
    query: paymentListQueryObject,
    data: z.array(paymentDto),
  },
  'GET /properties/{propertyId}/payments/{id}': { tag: 'Payments', summary: 'One payment', data: paymentDto },
  'GET /properties/{propertyId}/payments/{id}/receipt': {
    tag: 'Payments',
    summary: 'Receipt data: the payment and the hotel details from the invoice profile',
    data: receiptDto,
  },
  'POST /properties/{propertyId}/payments': {
    tag: 'Payments',
    summary:
      'Receive money on a folio, or a deposit on a booking before check-in (Idempotency-Key); 422 PAYMENT_EXCEEDS_BALANCE',
    body: recordPaymentRequest,
    data: paymentDto,
    status: 201,
  },
  'POST /properties/{propertyId}/payments/{id}/refunds': {
    tag: 'Payments',
    summary:
      'Refund part or all of a payment (Idempotency-Key, payment.refund); 422 REFUND_EXCEEDS_REMAINDER',
    body: refundRequest,
    data: paymentDto,
    status: 201,
  },
  'POST /properties/{propertyId}/reservations/{reservationId}/forfeit-deposit': {
    tag: 'Payments',
    summary: 'Keep the deposit of a cancelled or no-show booking as a fee (Idempotency-Key, folio.adjust)',
    body: voidChargeRequest,
    data: z.object({ amount: z.string() }),
    status: 200,
  },
  'GET /properties/{propertyId}/stays/{stayId}/checkout-preview': {
    tag: 'Check-out',
    summary:
      'What check-out will do: room nights to post, deposits to apply, and what each folio needs to settle',
    data: checkoutPreviewDto,
  },
  'POST /properties/{propertyId}/stays/{stayId}/check-out': {
    tag: 'Check-out',
    summary:
      'Check out (Idempotency-Key): post room nights, apply deposits, settle every folio (409 SETTLEMENT_REQUIRED otherwise), issue invoices',
    body: checkOutRequest,
    data: checkOutResultDto,
    status: 200,
  },
  'GET /properties/{propertyId}/invoices/{id}': {
    tag: 'Check-out',
    summary: 'An issued invoice, frozen at check-out',
    data: invoiceDto,
  },
  'GET /finance/accounts': {
    tag: 'Ledger',
    summary: 'Chart of accounts, active and inactive, by code',
    data: z.array(accountDto),
  },
  'POST /finance/accounts': {
    tag: 'Ledger',
    summary: 'Add an account (code starts with the digit of its class)',
    body: createAccountRequest,
    data: accountDto,
    status: 201,
  },
  'PATCH /finance/accounts/{id}': {
    tag: 'Ledger',
    summary: 'Rename, re-parent or (de)activate an account; system accounts stay active',
    body: updateAccountRequest,
    data: accountDto,
  },
  'GET /finance/journal-entries': {
    tag: 'Ledger',
    summary: 'Journal entries, newest first',
    query: journalListQueryObject,
    data: journalListDto,
  },
  'GET /finance/journal-entries/{id}': {
    tag: 'Ledger',
    summary: 'One journal entry with its lines',
    data: journalEntryDto,
  },
  'POST /finance/journal-entries/draft': {
    tag: 'Ledger',
    summary: 'Save a manual journal draft (Idempotency-Key); drafts may be unbalanced',
    body: journalDraftRequest,
    data: journalEntryDto,
    status: 201,
  },
  'PUT /finance/journal-entries/{id}': {
    tag: 'Ledger',
    summary: 'Replace a manual draft',
    body: journalDraftRequest,
    data: journalEntryDto,
  },
  'DELETE /finance/journal-entries/{id}': {
    tag: 'Ledger',
    summary: 'Delete a manual draft (posted entries are never deleted)',
    data: z.object({ id: z.string().uuid() }),
    status: 200,
  },
  'POST /finance/journal-entries/{id}/post': {
    tag: 'Ledger',
    summary: 'Post a draft once (Idempotency-Key); 422 JOURNAL_UNBALANCED, 409 PERIOD_CLOSED',
    data: journalEntryDto,
    status: 200,
  },
  'POST /finance/journal-entries/{id}/reverse': {
    tag: 'Ledger',
    summary:
      'Reverse a posted manual journal with an equal and opposite entry (Idempotency-Key); returns the reversal',
    body: reverseJournalRequest,
    data: journalEntryDto,
    status: 200,
  },
  'GET /finance/ledger': {
    tag: 'Ledger',
    summary: 'Account ledger with opening, movements and running balance (debit minus credit)',
    query: ledgerQueryObject,
    data: ledgerDto,
  },
  'GET /finance/trial-balance': {
    tag: 'Ledger',
    summary: 'Trial balance for a date range, all accounts, from posted entries only',
    query: trialBalanceQueryObject,
    data: trialBalanceDto,
  },
  'GET /finance/periods': {
    tag: 'Ledger',
    summary: 'Monthly accounting periods with their status and entry counts',
    data: z.array(fiscalPeriodDto),
  },
  'POST /finance/periods/{month}/close': {
    tag: 'Ledger',
    summary: 'Close a month: no more postings into it',
    data: z.array(fiscalPeriodDto),
    status: 200,
  },
  'POST /finance/periods/{month}/reopen': {
    tag: 'Ledger',
    summary: 'Reopen a closed month with a reason (audited)',
    body: reopenPeriodRequest,
    data: z.array(fiscalPeriodDto),
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
