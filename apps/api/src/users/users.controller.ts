import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import {
  type PasswordResetResponse,
  createUserRequest,
  reasonRequest,
  setUserRolesRequest,
  setUserStatusRequest,
  type CreateUserRequest,
  type ReasonRequest,
  type SetUserRolesRequest,
  type SetUserStatusRequest,
  type UserDto,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { UsersService } from './users.service';

const userId = new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound('user') });

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('user.read')
  list(@CurrentAuth() auth: AuthContext): Promise<UserDto[]> {
    return this.users.list(auth);
  }

  @Post()
  @RequirePermission('user.manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createUserRequest)) body: CreateUserRequest,
    @Req() req: AppRequest,
  ): Promise<UserDto> {
    return this.users.create(auth, body, requestMeta(req));
  }

  @Put(':id/roles')
  @RequirePermission('user.manage')
  setRoles(
    @CurrentAuth() auth: AuthContext,
    @Param('id', userId) id: string,
    @Body(new ZodPipe(setUserRolesRequest)) body: SetUserRolesRequest,
    @Req() req: AppRequest,
  ): Promise<UserDto> {
    return this.users.setRoles(auth, id, body.roles, requestMeta(req));
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('user.manage')
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', userId) id: string,
    @Body(new ZodPipe(setUserStatusRequest)) body: SetUserStatusRequest,
    @Req() req: AppRequest,
  ): Promise<UserDto> {
    return this.users.setStatus(auth, id, body.status, body.reason, requestMeta(req));
  }

  @Post(':id/mfa/reset')
  @HttpCode(200)
  @RequirePermission('user.manage')
  resetMfa(
    @CurrentAuth() auth: AuthContext,
    @Param('id', userId) id: string,
    @Body(new ZodPipe(reasonRequest)) body: ReasonRequest,
    @Req() req: AppRequest,
  ): Promise<UserDto> {
    return this.users.resetMfa(auth, id, body.reason, requestMeta(req));
  }

  /** D18: a one-time temporary password for a staff member, shown once to hand over in person. */
  @Post(':id/password-reset')
  @HttpCode(200)
  @RequirePermission('user.manage')
  resetPassword(
    @CurrentAuth() auth: AuthContext,
    @Param('id', userId) id: string,
    @Body(new ZodPipe(reasonRequest)) body: ReasonRequest,
    @Req() req: AppRequest,
  ): Promise<PasswordResetResponse> {
    return this.users.resetPassword(auth, id, body.reason, requestMeta(req));
  }
}
