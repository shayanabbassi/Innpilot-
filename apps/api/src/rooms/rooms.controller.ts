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
  Req,
} from '@nestjs/common';
import {
  bulkCreateRoomsRequest,
  createRateRequest,
  createRoomRequest,
  createRoomTypeRequest,
  updateRoomRequest,
  updateRoomTypeRequest,
  type BulkCreateRoomsRequest,
  type CreateRateRequest,
  type CreateRoomRequest,
  type CreateRoomTypeRequest,
  type RoomBoardDto,
  type RoomDto,
  type RoomTypeDto,
  type RoomTypeRateDto,
  type UpdateRoomRequest,
  type UpdateRoomTypeRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { RoomsService } from './rooms.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/** Everything here is scoped by the property in the path; the guard checks the caller's access to it. */
@Controller('properties/:propertyId')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get('room-types')
  @RequirePermission('room.read', P)
  listRoomTypes(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<RoomTypeDto[]> {
    return this.rooms.listRoomTypes(auth, propertyId);
  }

  @Post('room-types')
  @RequirePermission('room.manage', P)
  createRoomType(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(createRoomTypeRequest)) body: CreateRoomTypeRequest,
    @Req() req: AppRequest,
  ): Promise<RoomTypeDto> {
    return this.rooms.createRoomType(auth, propertyId, body, requestMeta(req));
  }

  @Patch('room-types/:id')
  @RequirePermission('room.manage', P)
  updateRoomType(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('room type')) id: string,
    @Body(new ZodPipe(updateRoomTypeRequest)) body: UpdateRoomTypeRequest,
    @Req() req: AppRequest,
  ): Promise<RoomTypeDto> {
    return this.rooms.updateRoomType(auth, propertyId, id, body, requestMeta(req));
  }

  @Get('room-types/:id/rates')
  @RequirePermission('room.read', P)
  listRates(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('room type')) id: string,
  ): Promise<RoomTypeRateDto[]> {
    return this.rooms.listRates(auth, propertyId, id);
  }

  @Post('room-types/:id/rates')
  @RequirePermission('room.manage', P)
  addRate(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('room type')) id: string,
    @Body(new ZodPipe(createRateRequest)) body: CreateRateRequest,
    @Req() req: AppRequest,
  ): Promise<RoomTypeRateDto> {
    return this.rooms.addRate(auth, propertyId, id, body, requestMeta(req));
  }

  @Delete('room-types/:id/rates/:rateId')
  @HttpCode(200)
  @RequirePermission('room.manage', P)
  removeRate(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('room type')) id: string,
    @Param('rateId', uuid('rate')) rateId: string,
    @Req() req: AppRequest,
  ): Promise<null> {
    return this.rooms.removeRate(auth, propertyId, id, rateId, requestMeta(req));
  }

  @Get('rooms')
  @RequirePermission('room.read', P)
  listRooms(@CurrentAuth() auth: AuthContext, @Param('propertyId') propertyId: string): Promise<RoomDto[]> {
    return this.rooms.listRooms(auth, propertyId);
  }

  @Post('rooms')
  @RequirePermission('room.manage', P)
  async createRoom(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(createRoomRequest)) body: CreateRoomRequest,
    @Req() req: AppRequest,
  ): Promise<RoomDto> {
    const [room] = await this.rooms.createRooms(auth, propertyId, body, requestMeta(req));
    return room!;
  }

  /** All-or-nothing: if any number in the range exists, nothing is created and the clashes are listed. */
  @Post('rooms/bulk')
  @RequirePermission('room.manage', P)
  createRoomsBulk(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(bulkCreateRoomsRequest)) body: BulkCreateRoomsRequest,
    @Req() req: AppRequest,
  ): Promise<RoomDto[]> {
    return this.rooms.createRooms(auth, propertyId, body, requestMeta(req));
  }

  @Patch('rooms/:id')
  @RequirePermission('room.manage', P)
  updateRoom(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('room')) id: string,
    @Body(new ZodPipe(updateRoomRequest)) body: UpdateRoomRequest,
    @Req() req: AppRequest,
  ): Promise<RoomDto> {
    return this.rooms.updateRoom(auth, propertyId, id, body, requestMeta(req));
  }

  @Get('room-board')
  @RequirePermission('room.read', P)
  board(@CurrentAuth() auth: AuthContext, @Param('propertyId') propertyId: string): Promise<RoomBoardDto> {
    return this.rooms.board(auth, propertyId);
  }
}
