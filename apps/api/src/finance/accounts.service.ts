import { Injectable } from '@nestjs/common';
import {
  defaultNormalBalance,
  reportGroupsFor,
  type AccountClass,
  type AccountDto,
  type ReportGroup,
  type CreateAccountRequest,
  type UpdateAccountRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { asc, eq } from 'drizzle-orm';
import { AuditService, changeSet } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';

const a = schema.accounts;
type Row = typeof a.$inferSelect;

/** The tenant's chart of accounts. Accounts are never deleted; code, class and system role never change. */
@Injectable()
export class AccountsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<AccountDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) =>
      (await tx.select().from(a).orderBy(asc(a.code))).map(dto),
    );
  }

  async create(auth: AuthContext, body: CreateAccountRequest, meta: RequestMeta): Promise<AccountDto> {
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        if (body.parentId) await this.assertParent(tx, body.parentId, body.accountClass, null);
        const [row] = await tx
          .insert(a)
          .values({
            tenantId: auth.tenantId,
            code: body.code,
            name: body.name,
            accountClass: body.accountClass,
            normalBalance: body.normalBalance ?? defaultNormalBalance(body.accountClass),
            parentId: body.parentId ?? null,
            ...(body.reportGroup ? { reportGroup: body.reportGroup } : {}),
          })
          .returning();
        await this.record(tx, auth, meta, 'account.created', row!.id, {
          code: row!.code,
          name: row!.name,
          accountClass: row!.accountClass,
          reportGroup: row!.reportGroup,
        });
        return dto(row!);
      });
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw AppError.validation('That account code is already used.', [
          { path: 'code', message: `Account ${body.code} already exists.` },
        ]);
      }
      throw err;
    }
  }

  update(auth: AuthContext, id: string, body: UpdateAccountRequest, meta: RequestMeta): Promise<AccountDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [before] = await tx.select().from(a).where(eq(a.id, id)).for('update');
      if (!before) throw AppError.notFound('account');
      if (body.active === false && before.systemRole) {
        throw AppError.validation(
          `${before.code} ${before.name} is used by the posting rules and cannot be deactivated.`,
        );
      }
      if (body.parentId) await this.assertParent(tx, body.parentId, before.accountClass as AccountClass, id);
      if (
        body.reportGroup &&
        !reportGroupsFor(before.accountClass as AccountClass).includes(body.reportGroup)
      ) {
        throw AppError.validation('Choose a report group that fits the account class.', [
          { path: 'reportGroup', message: 'This group does not fit the account class.' },
        ]);
      }
      const set = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.reportGroup !== undefined ? { reportGroup: body.reportGroup } : {}),
      };
      // Drizzle refuses an update with nothing to set; an empty PATCH simply changes nothing.
      const row = Object.keys(set).length
        ? (await tx.update(a).set(set).where(eq(a.id, id)).returning())[0]!
        : before;
      const changes = changeSet(before, row, ['name', 'parentId', 'active', 'reportGroup']);
      if (Object.keys(changes).length > 0) {
        await this.record(tx, auth, meta, 'account.updated', id, { code: before.code, ...changes });
      }
      return dto(row);
    });
  }

  /** A parent must be in the same class, and not the account itself or one of its descendants. */
  private async assertParent(tx: Tx, parentId: string, cls: AccountClass, selfId: string | null) {
    const all = await tx.select({ id: a.id, parentId: a.parentId, cls: a.accountClass }).from(a);
    const byId = new Map(all.map((x) => [x.id, x]));
    const parent = byId.get(parentId);
    if (!parent) throw AppError.validation('Choose a parent from the chart of accounts.');
    if (parent.cls !== cls) throw AppError.validation('The parent account must be in the same class.');
    for (let p: string | null = parentId, guard = 0; p && guard < 50; guard++) {
      if (p === selfId) throw AppError.validation('An account cannot be placed under itself.');
      p = byId.get(p)?.parentId ?? null;
    }
  }

  private async record(
    tx: Tx,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    id: string,
    changes: Record<string, unknown>,
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: 'account',
        entityId: id,
        changes,
      },
      meta,
    );
  }
}

function dto(row: Row): AccountDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accountClass: row.accountClass as AccountClass,
    normalBalance: row.normalBalance as AccountDto['normalBalance'],
    parentId: row.parentId,
    systemRole: row.systemRole,
    active: row.active,
    reportGroup: row.reportGroup as ReportGroup,
  };
}

export { dto as accountDto };
