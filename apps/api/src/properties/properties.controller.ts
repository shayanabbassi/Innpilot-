import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import { updatePropertyRequest, type PropertyDto, type UpdatePropertyRequest } from '@innpilot/contracts';
import { schema } from '@innpilot/db';
import { eq, inArray } from 'drizzle-orm';
import { AuditService, changeSet } from '../audit/audit.service';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { Db } from '../db/db.module';

type PropertyRow = typeof schema.properties.$inferSelect;

function toDto(p: PropertyRow): PropertyDto {
  return {
    id: p.id,
    name: p.name,
    legalName: p.legalName,
    timezone: p.timezone,
    currencyCode: p.currencyCode,
    addressLine: p.addressLine,
    city: p.city,
    countryCode: p.countryCode,
    phone: p.phone,
    email: p.email,
    checkInTime: p.checkInTime.slice(0, 5),
    checkOutTime: p.checkOutTime.slice(0, 5),
    businessDate: p.businessDate,
    status: p.status,
  };
}

const AUDITED_FIELDS = [
  'name',
  'legalName',
  'timezone',
  'addressLine',
  'city',
  'phone',
  'email',
  'checkInTime',
  'checkOutTime',
] as const;

@Controller('properties')
export class PropertiesController {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Properties where the caller holds property.read. */
  @Get()
  @RequirePermission('property.read', 'any')
  list(@CurrentAuth() auth: AuthContext): Promise<PropertyDto[]> {
    const visible = [...auth.permissionsByProperty]
      .filter(([, p]) => p.has('property.read'))
      .map(([id]) => id);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.properties)
        .where(inArray(schema.properties.id, visible))
        .orderBy(schema.properties.name);
      return rows.map(toDto);
    });
  }

  @Get(':id')
  @RequirePermission('property.read', { propertyParam: 'id' })
  get(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<PropertyDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [row] = await tx.select().from(schema.properties).where(eq(schema.properties.id, id));
      if (!row) throw AppError.notFound('property');
      return toDto(row);
    });
  }

  @Patch(':id')
  @RequirePermission('property.manage', { propertyParam: 'id' })
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodPipe(updatePropertyRequest)) body: UpdatePropertyRequest,
    @Req() req: AppRequest,
  ): Promise<PropertyDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [before] = await tx
        .select()
        .from(schema.properties)
        .where(eq(schema.properties.id, id))
        .for('update');
      if (!before) throw AppError.notFound('property');
      const [after] = await tx
        .update(schema.properties)
        .set(body)
        .where(eq(schema.properties.id, id))
        .returning();
      const beforeDto = toDto(before);
      const changes = changeSet(beforeDto, toDto(after!), AUDITED_FIELDS);
      if (Object.keys(changes).length > 0) {
        await this.audit.record(
          tx,
          {
            tenantId: auth.tenantId,
            propertyId: id,
            actor: { type: 'user', userId: auth.userId },
            action: 'property.updated',
            entityType: 'property',
            entityId: id,
            changes,
          },
          requestMeta(req),
        );
      }
      return toDto(after!);
    });
  }
}
