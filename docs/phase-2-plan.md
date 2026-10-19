# Phase 2 — Hotel operations: slice plan

Status: **Decisions recorded 2026-10-19 — awaiting go-ahead for slice 2.1** · Date: 2026-10-19 · Builds on: Phase 1 (`phase-1-foundation`, c7a569a)

Scope (from the playbook and your brief): onboarding, room types, rooms, guests, reservations with conflict
prevention, check-in and housekeeping. **Check-out moves to Phase 3** (owner decision D4) so it can require a settled folio. Folios, payments and taxes are **Phase 3** (ledger core first), so nothing
here posts money.

Every slice ships: a migration, API endpoints in the OpenAPI contract, UI with loading/empty/error/denied/conflict
states, server-side permissions, audit events, and unit + Postgres integration + e2e tests (tenant and role
negative cases included). Each slice ends with all checks green and is committed separately.

---

## Design decisions (defaults I will use unless you say otherwise)

| #     | Topic                        | Decision                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1  | Stay dates                   | Half-open `[arrival, departure)` on property **business dates** (C7). A room departing on the 20th can take an arrival on the 20th.                                                                                                                                                                                                                                          |
| P2-2  | Room status (C5)             | Three independent facts: **occupancy** (derived from stays), **housekeeping state** (`dirty` / `cleaning` / `clean` / `inspected`) and **service state** (`in_service` / `out_of_order`). Board labels (vacant-clean, occupied, out-of-order…) are derived, never stored. Every change writes a `room_status_events` row.                                                    |
| P2-3  | Double-booking               | Two layers. **Assigned rooms:** PostgreSQL `EXCLUDE USING gist (room_id WITH =, daterange(arrival, departure, '[)') WITH &&)` over active reservation-room rows. **Unassigned (room-type) bookings:** the booking transaction locks the room-type row and checks, for every night, that bookings ≤ rooms of that type in service. A conflict returns `409 ROOM_UNAVAILABLE`. |
| P2-4  | Reservation model            | `reservations` (guest, source, status, notes, booking reference) → `reservation_rooms` (room type, optional room, dates, adults/children, agreed nightly rate). Multi-room and group bookings are several rows.                                                                                                                                                              |
| P2-5  | Reservation states           | `pending` → `confirmed` → `checked_in` → `checked_out`; `pending`/`confirmed` → `cancelled` or `no_show`. Transitions only through service functions; each is audited with a reason where required.                                                                                                                                                                          |
| P2-6  | Rates                        | One effective-dated **base nightly rate per room type**. The agreed rate is snapshotted on each reservation room, so later rate edits never change existing bookings. Overriding the rate needs a new `reservation.rate_override` permission plus a reason. Full rate plans come after the pilot.                                                                            |
| P2-7  | Booking reference            | 8-character human-readable code (no 0/O/1/I), unique per tenant. Not a fiscal document, so it doesn't need to be gapless.                                                                                                                                                                                                                                                    |
| P2-8  | Guests                       | Name, phone, email, nationality, address, preferences, marketing consent. Phone and email are normalised for search, and possible duplicates are shown on create (same phone, same email, or similar name).                                                                                                                                                                  |
| P2-9  | Identity documents           | Optional. Document type, issuing country and expiry are stored in the clear; the number is **encrypted** (AES-256-GCM, separate key `PII_ENCRYPTION_KEY`), with an HMAC column for exact-match lookup and the last 4 characters for display. Seeing the full number needs `guest.identity.read`, and every reveal writes an audit event.                                     |
| P2-10 | Check-in readiness (OPS-002) | Check-in requires: reservation `confirmed`, arrival on or before the business date, room assigned and in service, and housekeeping `clean` or `inspected`. An out-of-order or dirty room is blocked unless a holder of new permission `stay.readiness_override` gives a reason (audited).                                                                                    |
| P2-11 | Walk-in                      | One transaction: create guest (or pick existing), reservation, assignment and check-in.                                                                                                                                                                                                                                                                                      |
| P2-12 | Check-out (OPS-003)          | **Deferred to Phase 3** (D4), built together with folio settlement. In Phase 2, checked-in stays remain in house.                                                                                                                                                                                                                                                            |
| P2-13 | Room moves                   | Moving an in-house guest ends the current room segment and starts a new one, so history is kept. Both rooms get status events; the old room becomes dirty.                                                                                                                                                                                                                   |
| P2-14 | Housekeeping                 | Tasks (`clean`, `inspect`, `maintenance`) with assignee and states `open` → `in_progress` → `done`, plus `inspected` for clean tasks. Maintenance tickets can put a room out of order; that's refused if the room is occupied or has an assigned arrival in the period, unless a manager overrides with a reason.                                                            |
| P2-15 | New permissions              | `reservation.rate_override`, `stay.readiness_override`, `room.out_of_order` (migration updates the catalogue; contracts and the catalogue-match test stay in sync). Managers and owners get all three; front desk gets none.                                                                                                                                                 |

---

## Slices

### 2.1 Tenant provisioning and property onboarding

- **DB:** none new (properties exist). Adds `onboarding_completed_at` to properties (migration `0002_onboarding`).
- **API:** `POST /properties/{id}/onboarding/complete`; reuses `PATCH /properties/{id}`.
- **CLI:** `pnpm tenant:create` (creates tenant, first property and owner from prompts/flags; prints nothing secret).
- **Web:** onboarding wizard — business details → time zone and currency → room types and rooms (slice 2.2 screens embedded) → review. Save and resume. Unfinished onboarding sends the owner to the wizard.
- **Tests:** CLI creates an isolated tenant; wizard state per property; non-owner cannot complete onboarding.

### 2.2 Room types, rooms and base rates

- **DB `0003_rooms`:** `room_types` (code, name, capacity adults/children, active; unique code per property), `rooms` (number, floor, type, housekeeping/service state, active; unique number per property), `room_type_rates` (effective_from, nightly rate NUMERIC(19,4), currency), `room_status_events`. RLS and composite FKs as in Phase 1.
- **API:** CRUD for `/room-types`, `/rooms` (incl. bulk create "101–120"), `/room-types/{id}/rates`, `GET /room-board?date=`.
- **Web:** Settings → Rooms & rates; read-only room board.
- **Tests:** unique room number per property; cannot attach a room to another property's type (composite FK); rate effective-dating; money stays decimal end to end; cross-tenant and role negatives.

### 2.3 Guests

- **DB `0004_guests`:** `guests`, `guest_documents` (encrypted number + HMAC + last4), trigram/normalised indexes.
- **API:** `GET /guests?search=` (redacted list), `POST/PATCH /guests`, `GET /guests/{id}`, `GET /guests/{id}/duplicates`, `POST /guests/{id}/documents`, `POST /guest-documents/{id}/reveal` (audited).
- **Web:** guest search, profile, create/edit with duplicate warning, document panel gated by permission.
- **Tests:** search never returns document numbers (SEC); reveal requires `guest.identity.read` and is audited (AUD); document number never in logs or audit `changes`; duplicate detection; isolation.

### 2.4 Reservations and availability — **OPS-001 gate**

- **DB `0005_reservations`:** `reservations`, `reservation_rooms` with the exclusion constraint (needs `btree_gist`), status checks, `reservation_events` history.
- **API:** `GET /availability`, `GET/POST /reservations`, `GET/PATCH /reservations/{id}`, `POST …/confirm`, `…/cancel` (reason), `…/no-show`, `…/assign-room`, `…/rooms` (add/remove for groups). `Idempotency-Key` on create.
- **Web:** reservation calendar (room × date grid, room-type view), booking drawer with live availability, conflict message with alternative rooms, reservation detail with history.
- **Tests:** **20 concurrent bookings for the same room/night: exactly one succeeds** (assigned) and room-type inventory never oversold (unassigned); departure must follow arrival; cancelled bookings free the room; agreed rate unchanged after a rate edit; idempotent create; rate override needs permission + reason; isolation (cannot book another tenant's room or guest by id).

### 2.5 Front desk: check-in, walk-in, room move — **OPS-002 gate**

- **DB `0006_stays`:** `stays`, `stay_rooms` (segments for moves).
- **API:** `POST /reservations/{id}/check-in`, `POST /walk-ins`, `POST /stays/{id}/move`, `GET /stays?status=in_house`, `GET /front-desk/today` (arrivals, departures, in-house).
- **Web:** Front desk "Today" (arrivals / in-house / departures), check-in stepper, walk-in flow, room move. Must work at 360px (UX-001).
- **Tests:** OPS-002 (blocked unless override with reason; audited); idempotent check-in (retry does not create a second stay); double check-in prevented; moving into an occupied room → 409; all transitions atomic (forced failure rolls back everything).

### 2.6 Housekeeping and maintenance

- **DB `0007_housekeeping`:** `housekeeping_tasks`, `maintenance_tickets`.
- **API:** `GET/POST /housekeeping/tasks`, `PATCH /housekeeping/tasks/{id}` (start/complete/inspect), `POST /maintenance/tickets`, `POST /maintenance/tickets/{id}/resolve`, `POST /rooms/{id}/out-of-order` / `…/return-to-service`.
- **Web:** housekeeping board (cards on phone), my-tasks view for housekeeping staff, maintenance list.
- **Tests:** invalid transitions rejected (room can't be marked clean without allowed transition); housekeeping role sees no guest names (room board privacy rule); out-of-order refused when occupied/arriving unless override; front desk sees readiness change immediately.

### 2.7 Interim business-date close _(approved, D3)_

- **API:** `POST /business-date/close` (`night_audit.run`): checks for arrivals not checked in (offer no-show), in-house stays past departure (expected until Phase 3 adds check-out; shown as a warning, not a blocker), and dirty rooms; requires a reason to proceed with warnings; advances the date; stores a close record with a unique key on (property, business date) so a second run can't double-advance (OPS-004 pattern).
- Replaced by the full night audit (room charge posting) in Phase 4; this keeps the operational parts.

---

## Order and estimate

2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 → (2.7). Each slice is one reviewable commit with tests run and reported.
2.4 and 2.5 are the largest (concurrency and state machines).

## Phase 2 exit gate (executed, not assumed)

OPS-001 and OPS-002 pass; reservation-to-check-in e2e (Scenario A steps 1–4) passes; interim day close cannot double-advance; cross-tenant
attempts on rooms, guests, reservations and stays are denied (Scenario D, booking part); guest identity data never
appears in search results or logs; all primary flows usable at 360/768/1280 px.

## Owner decisions (2026-10-19)

| #   | Question                         | Decision                                                                                                  |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| D1  | How tenants are created          | Operator CLI (`pnpm tenant:create`); self-signup waits for the Phase 5 platform admin.                    |
| D2  | Guest identity documents         | Optional, encrypted, masked; reveal permission-gated and audited (P2-9). Local legal review before pilot. |
| D3  | Business date before night audit | Interim operational day close, slice 2.7.                                                                 |
| D4  | Check-out before folios          | Deferred to Phase 3; OPS-003 becomes a Phase 3 gate.                                                      |

Defaults P2-1 to P2-15 above stand unless changed.
