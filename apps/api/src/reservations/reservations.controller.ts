import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  assignRoomRequest,
  availabilityQuery,
  cancelReservationRequest,
  createReservationRequest,
  IDEMPOTENCY_HEADER,
  noShowRequest,
  reservationListQuery,
  reservationRoomInput,
  updateReservationRequest,
  type AssignRoomRequest,
  type AuditEventDto,
  type AvailabilityDto,
  type AvailabilityQuery,
  type CancelReservationRequest,
  type CreateReservationRequest,
  type NoShowRequest,
  type ReservationDto,
  type ReservationListQuery,
  type ReservationRoomInput,
  type UpdateReservationRequest,
} from '@innpilot/contracts';
import type { Response } from 'express';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { ReservationsService } from './reservations.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

@Controller('properties/:propertyId')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  /** Advisory: every booking write re-checks availability inside its own transaction. */
  @Get('availability')
  @RequirePermission('reservation.read', P)
  availability(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(availabilityQuery)) q: AvailabilityQuery,
  ): Promise<AvailabilityDto> {
    return this.reservations.availability(auth, propertyId, q);
  }

  @Get('reservations')
  @RequirePermission('reservation.read', P)
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(reservationListQuery)) q: ReservationListQuery,
  ): Promise<ReservationDto[]> {
    return this.reservations.list(auth, propertyId, q);
  }

  /** Requires an Idempotency-Key header: a retried request returns the original booking instead of a second one. */
  @Post('reservations')
  @RequirePermission('reservation.write', P)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(createReservationRequest)) body: CreateReservationRequest,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReservationDto> {
    const result = await this.reservations.create(
      auth,
      propertyId,
      body,
      req.get(IDEMPOTENCY_HEADER),
      requestMeta(req),
    );
    res.status(result.status);
    return result.body;
  }

  @Get('reservations/:id')
  @RequirePermission('reservation.read', P)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
  ): Promise<ReservationDto> {
    return this.reservations.get(auth, propertyId, id);
  }

  @Get('reservations/:id/history')
  @RequirePermission('reservation.read', P)
  history(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
  ): Promise<AuditEventDto[]> {
    return this.reservations.history(auth, propertyId, id);
  }

  @Patch('reservations/:id')
  @RequirePermission('reservation.write', P)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Body(new ZodPipe(updateReservationRequest)) body: UpdateReservationRequest,
    @Req() req: AppRequest,
  ): Promise<ReservationDto> {
    return this.reservations.update(auth, propertyId, id, body, requestMeta(req));
  }

  @Post('reservations/:id/confirm')
  @HttpCode(200)
  @RequirePermission('reservation.write', P)
  confirm(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Req() req: AppRequest,
  ): Promise<ReservationDto> {
    return this.reservations.confirm(auth, propertyId, id, requestMeta(req));
  }

  @Post('reservations/:id/cancel')
  @HttpCode(200)
  @RequirePermission('reservation.write', P)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Body(new ZodPipe(cancelReservationRequest)) body: CancelReservationRequest,
    @Req() req: AppRequest,
  ): Promise<ReservationDto> {
    return this.reservations.cancel(auth, propertyId, id, body.reason, requestMeta(req), body.deposit);
  }

  @Post('reservations/:id/no-show')
  @HttpCode(200)
  @RequirePermission('reservation.write', P)
  noShow(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Body(new ZodPipe(noShowRequest)) body: NoShowRequest,
    @Req() req: AppRequest,
  ): Promise<ReservationDto> {
    return this.reservations.noShow(auth, propertyId, id, body.reason, requestMeta(req), body.deposit);
  }

  @Post('reservations/:id/rooms')
  @RequirePermission('reservation.write', P)
  addRoom(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Body(new ZodPipe(reservationRoomInput)) body: ReservationRoomInput,
    @Req() req: AppRequest,
  ): Promise<ReservationDto> {
    return this.reservations.addRoom(auth, propertyId, id, body, requestMeta(req));
  }

  @Put('reservations/:id/rooms/:roomId')
  @RequirePermission('reservation.write', P)
  changeRoom(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Param('roomId', uuid('booked room')) reservationRoomId: string,
    @Body(new ZodPipe(reservationRoomInput)) body: ReservationRoomInput,
    @Req() req: AppRequest,
  ): Promise<ReservationDto> {
    return this.reservations.changeRoom(auth, propertyId, id, reservationRoomId, body, requestMeta(req));
  }

  @Post('reservations/:id/rooms/:roomId/assign')
  @HttpCode(200)
  @RequirePermission('reservation.write', P)
  assignRoom(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Param('roomId', uuid('booked room')) reservationRoomId: string,
    @Body(new ZodPipe(assignRoomRequest)) body: AssignRoomRequest,
    @Req() req: AppRequest,
  ): Promise<ReservationDto> {
    return this.reservations.assignRoom(
      auth,
      propertyId,
      id,
      reservationRoomId,
      body.roomId,
      requestMeta(req),
    );
  }

  @Delete('reservations/:id/rooms/:roomId')
  @HttpCode(200)
  @RequirePermission('reservation.write', P)
  removeRoom(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Param('roomId', uuid('booked room')) reservationRoomId: string,
    @Req() req: AppRequest,
  ): Promise<ReservationDto> {
    return this.reservations.removeRoom(auth, propertyId, id, reservationRoomId, requestMeta(req));
  }
}
