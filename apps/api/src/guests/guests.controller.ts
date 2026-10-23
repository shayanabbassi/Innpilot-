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
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  createGuestRequest,
  duplicateCheckRequest,
  guestDocumentInput,
  guestSearchQuery,
  revealRequest,
  updateGuestRequest,
  uploadQuery,
  type CreateGuestRequest,
  type DuplicateCandidateDto,
  type DuplicateCheckRequest,
  type FileLinkDto,
  type GuestDocumentInput,
  type GuestDto,
  type GuestSearchQuery,
  type GuestSummaryDto,
  type RevealedDocumentDto,
  type RevealRequest,
  type UpdateGuestRequest,
  type UploadQuery,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AttachmentsService } from '../storage/attachments.service';
import { GuestsService } from './guests.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/** Guests are shared by the tenant's properties, so permissions are checked on any property the caller holds. */
@Controller('guests')
export class GuestsController {
  constructor(
    private readonly guests: GuestsService,
    private readonly files: AttachmentsService,
  ) {}

  @Get()
  @RequirePermission('guest.read', 'any')
  search(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(guestSearchQuery)) query: GuestSearchQuery,
  ): Promise<GuestSummaryDto[]> {
    return this.guests.search(auth, query);
  }

  /** Looks for existing guests matching what is being typed, before creating a new profile. */
  @Post('duplicate-check')
  @HttpCode(200)
  @RequirePermission('guest.write', 'any')
  duplicates(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(duplicateCheckRequest)) body: DuplicateCheckRequest,
  ): Promise<DuplicateCandidateDto[]> {
    return this.guests.duplicates(auth, body);
  }

  @Post()
  @RequirePermission('guest.write', 'any')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createGuestRequest)) body: CreateGuestRequest,
    @Req() req: AppRequest,
  ): Promise<GuestDto> {
    return this.guests.create(auth, body, requestMeta(req));
  }

  @Get(':id')
  @RequirePermission('guest.read', 'any')
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid('guest')) id: string): Promise<GuestDto> {
    return this.guests.get(auth, id);
  }

  @Patch(':id')
  @RequirePermission('guest.write', 'any')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('guest')) id: string,
    @Body(new ZodPipe(updateGuestRequest)) body: UpdateGuestRequest,
    @Req() req: AppRequest,
  ): Promise<GuestDto> {
    return this.guests.update(auth, id, body, requestMeta(req));
  }

  /** Needs guest.write here plus guest.identity.read (checked in the service). */
  @Post(':id/documents')
  @RequirePermission('guest.write', 'any')
  addDocument(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('guest')) id: string,
    @Body(new ZodPipe(guestDocumentInput)) body: GuestDocumentInput,
    @Req() req: AppRequest,
  ): Promise<GuestDto> {
    return this.guests.addDocument(auth, id, body, requestMeta(req));
  }

  @Delete(':id/documents/:documentId')
  @HttpCode(200)
  @RequirePermission('guest.write', 'any')
  removeDocument(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('guest')) id: string,
    @Param('documentId', uuid('document')) documentId: string,
    @Req() req: AppRequest,
  ): Promise<GuestDto> {
    return this.guests.removeDocument(auth, id, documentId, requestMeta(req));
  }

  @Post(':id/documents/:documentId/reveal')
  @HttpCode(200)
  @RequirePermission('guest.identity.read', 'any')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  reveal(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('guest')) id: string,
    @Param('documentId', uuid('document')) documentId: string,
    @Body(new ZodPipe(revealRequest)) body: RevealRequest,
    @Req() req: AppRequest,
  ): Promise<RevealedDocumentDto> {
    return this.guests.reveal(auth, id, documentId, body.reason, requestMeta(req));
  }

  /**
   * Upload a scan of an identity document (slice 6.2): the body is the file (PDF, JPEG or PNG, at most 5 MB).
   * Needs guest.write here plus guest.identity.read (checked in the service). The stored name is neutral.
   */
  @Post(':id/scans')
  @HttpCode(200)
  @RequirePermission('guest.write', 'any')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async addScan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('guest')) id: string,
    // The name is accepted for the same upload shape as expenses, then replaced: it may hold guest data.
    @Query(new ZodPipe(uploadQuery)) _q: UploadQuery,
    @Req() req: AppRequest,
  ): Promise<GuestDto> {
    const file = await this.files.readUpload(req);
    return this.guests.addScan(auth, id, file, requestMeta(req));
  }

  /** A five-minute download link for the caller only, with a reason; audited (SEC-003). */
  @Post(':id/scans/:scanId/link')
  @HttpCode(200)
  @RequirePermission('guest.identity.read', 'any')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  scanLink(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('guest')) id: string,
    @Param('scanId', uuid('file')) scanId: string,
    @Body(new ZodPipe(revealRequest)) body: RevealRequest,
    @Req() req: AppRequest,
  ): Promise<FileLinkDto> {
    return this.guests.scanLink(auth, id, scanId, body.reason, requestMeta(req));
  }

  @Delete(':id/scans/:scanId')
  @HttpCode(200)
  @RequirePermission('guest.write', 'any')
  removeScan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('guest')) id: string,
    @Param('scanId', uuid('file')) scanId: string,
    @Req() req: AppRequest,
  ): Promise<GuestDto> {
    return this.guests.removeScan(auth, id, scanId, requestMeta(req));
  }
}
