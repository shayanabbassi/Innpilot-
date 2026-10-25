import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import {
  checkInRequest,
  IDEMPOTENCY_HEADER,
  moveRoomRequest,
  walkInRequest,
  type CheckInRequest,
  type FrontDeskTodayDto,
  type MoveRoomRequest,
  type StayDto,
  type WalkInRequest,
} from '@innpilot/contracts';
import type { Response } from 'express';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { StaysService } from './stays.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

@Controller('properties/:propertyId')
export class StaysController {
  constructor(private readonly stays: StaysService) {}

  @Get('front-desk/today')
  @RequirePermission('reservation.read', P)
  today(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<FrontDeskTodayDto> {
    return this.stays.today(auth, propertyId);
  }

  /** Requires an Idempotency-Key header, so a retried request cannot check the guest in twice. */
  @Post('reservations/:id/rooms/:roomId/check-in')
  @HttpCode(200)
  @RequirePermission('stay.checkin', P)
  async checkIn(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('reservation')) id: string,
    @Param('roomId', uuid('booked room')) reservationRoomId: string,
    @Body(new ZodPipe(checkInRequest)) body: CheckInRequest,
    @Req() req: AppRequest,
  ): Promise<StayDto> {
    const result = await this.stays.checkIn(
      auth,
      propertyId,
      id,
      reservationRoomId,
      body,
      req.get(IDEMPOTENCY_HEADER),
      requestMeta(req),
    );
    return result.body;
  }

  /** Requires an Idempotency-Key header. Needs reservation.write as well (checked when the booking is created). */
  @Post('walk-ins')
  @RequirePermission('stay.checkin', P)
  async walkIn(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(walkInRequest)) body: WalkInRequest,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StayDto> {
    if (!auth.permissionsByProperty.get(propertyId)?.has('reservation.write')) throw AppError.forbidden();
    const result = await this.stays.walkIn(
      auth,
      propertyId,
      body,
      req.get(IDEMPOTENCY_HEADER),
      requestMeta(req),
    );
    res.status(result.status);
    return result.body;
  }

  @Get('stays/:stayId')
  @RequirePermission('reservation.read', P)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('stayId', uuid('stay')) stayId: string,
  ): Promise<StayDto> {
    return this.stays.get(auth, propertyId, stayId);
  }

  @Post('stays/:stayId/move')
  @HttpCode(200)
  @RequirePermission('stay.checkin', P)
  move(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('stayId', uuid('stay')) stayId: string,
    @Body(new ZodPipe(moveRoomRequest)) body: MoveRoomRequest,
    @Req() req: AppRequest,
  ): Promise<StayDto> {
    return this.stays.move(auth, propertyId, stayId, body, requestMeta(req));
  }
}
