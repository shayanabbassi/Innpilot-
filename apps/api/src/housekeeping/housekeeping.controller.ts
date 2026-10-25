import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  completeTaskRequest,
  createTaskRequest,
  createTicketRequest,
  resolveTicketRequest,
  setHousekeepingStateRequest,
  taskListQuery,
  ticketListQuery,
  updateTaskRequest,
  type CompleteTaskRequest,
  type CreateTaskRequest,
  type CreateTicketRequest,
  type ResolveTicketRequest,
  type SetHousekeepingStateRequest,
  type StaffMemberDto,
  type TaskDto,
  type TaskListQuery,
  type TicketDto,
  type TicketListQuery,
  type UpdateTaskRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { HousekeepingService } from './housekeeping.service';
import { MaintenanceService } from './maintenance.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

@Controller('properties/:propertyId')
export class HousekeepingController {
  constructor(
    private readonly housekeeping: HousekeepingService,
    private readonly maintenance: MaintenanceService,
  ) {}

  @Post('rooms/:roomId/housekeeping-state')
  @HttpCode(200)
  @RequirePermission('housekeeping.write', P)
  setState(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('roomId', uuid('room')) roomId: string,
    @Body(new ZodPipe(setHousekeepingStateRequest)) body: SetHousekeepingStateRequest,
    @Req() req: AppRequest,
  ) {
    return this.housekeeping.setState(auth, propertyId, roomId, body.state, body.reason, requestMeta(req));
  }

  @Get('housekeeping/tasks')
  @RequirePermission('housekeeping.read', P)
  tasks(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(taskListQuery)) q: TaskListQuery,
  ): Promise<TaskDto[]> {
    return this.housekeeping.list(auth, propertyId, q);
  }

  @Get('housekeeping/staff')
  @RequirePermission('housekeeping.read', P)
  staff(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<StaffMemberDto[]> {
    return this.housekeeping.staff(auth, propertyId);
  }

  @Post('housekeeping/tasks')
  @RequirePermission('housekeeping.write', P)
  createTask(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(createTaskRequest)) body: CreateTaskRequest,
    @Req() req: AppRequest,
  ): Promise<TaskDto> {
    return this.housekeeping.create(auth, propertyId, body, requestMeta(req));
  }

  @Patch('housekeeping/tasks/:id')
  @RequirePermission('housekeeping.write', P)
  updateTask(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('task')) id: string,
    @Body(new ZodPipe(updateTaskRequest)) body: UpdateTaskRequest,
    @Req() req: AppRequest,
  ): Promise<TaskDto> {
    return this.housekeeping.update(auth, propertyId, id, body, requestMeta(req));
  }

  @Post('housekeeping/tasks/:id/start')
  @HttpCode(200)
  @RequirePermission('housekeeping.write', P)
  startTask(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('task')) id: string,
    @Req() req: AppRequest,
  ): Promise<TaskDto> {
    return this.housekeeping.start(auth, propertyId, id, requestMeta(req));
  }

  @Post('housekeeping/tasks/:id/complete')
  @HttpCode(200)
  @RequirePermission('housekeeping.write', P)
  completeTask(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('task')) id: string,
    @Body(new ZodPipe(completeTaskRequest)) body: CompleteTaskRequest,
    @Req() req: AppRequest,
  ): Promise<TaskDto> {
    return this.housekeeping.complete(auth, propertyId, id, body, requestMeta(req));
  }

  @Post('housekeeping/tasks/:id/cancel')
  @HttpCode(200)
  @RequirePermission('housekeeping.write', P)
  cancelTask(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('task')) id: string,
    @Req() req: AppRequest,
  ): Promise<TaskDto> {
    return this.housekeeping.cancel(auth, propertyId, id, requestMeta(req));
  }

  @Get('maintenance/tickets')
  @RequirePermission('housekeeping.read', P)
  tickets(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(ticketListQuery)) q: TicketListQuery,
  ): Promise<TicketDto[]> {
    return this.maintenance.list(auth, propertyId, q);
  }

  /** Anyone in housekeeping can report a problem; an out-of-order period also needs room.out_of_order. */
  @Post('maintenance/tickets')
  @RequirePermission('housekeeping.write', P)
  createTicket(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(createTicketRequest)) body: CreateTicketRequest,
    @Req() req: AppRequest,
  ): Promise<TicketDto> {
    return this.maintenance.create(auth, propertyId, body, requestMeta(req));
  }

  @Post('maintenance/tickets/:id/start')
  @HttpCode(200)
  @RequirePermission('housekeeping.write', P)
  startTicket(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('ticket')) id: string,
  ): Promise<TicketDto> {
    return this.maintenance.start(auth, propertyId, id);
  }

  @Post('maintenance/tickets/:id/resolve')
  @HttpCode(200)
  @RequirePermission('housekeeping.write', P)
  resolveTicket(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('ticket')) id: string,
    @Body(new ZodPipe(resolveTicketRequest)) body: ResolveTicketRequest,
    @Req() req: AppRequest,
  ): Promise<TicketDto> {
    return this.maintenance.resolve(auth, propertyId, id, body.note, requestMeta(req));
  }
}
