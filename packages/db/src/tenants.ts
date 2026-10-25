import { createTenantInput, type CreateTenantInput } from '@innpilot/contracts';
import { Client } from 'pg';
import { hashPassword } from './password';
import { todayIn } from './seed';

export interface CreatedTenant {
  tenantId: string;
  propertyId: string;
  ownerUserId: string;
}

export class TenantProvisioningError extends Error {
  override readonly name = 'TenantProvisioningError';
}

const UNIQUE_VIOLATION = '23505';

/**
 * Creates a tenant, its first property (onboarding not yet completed) and a tenant-wide owner, in one
 * transaction, and records a platform audit event. Runs with the admin connection because a new tenant
 * has no rows the application role could see yet.
 */
export async function createTenant(adminUrl: string, raw: CreateTenantInput): Promise<CreatedTenant> {
  const parsed = createTenantInput.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new TenantProvisioningError(`Invalid tenant details — ${issues}`);
  }
  const input = parsed.data;
  const passwordHash = await hashPassword(input.ownerPassword);

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query<{ id: string }>(
      `INSERT INTO tenants (slug, legal_name, display_name, status, base_currency)
       VALUES ($1, $2, $3, 'trial', $4) RETURNING id`,
      [input.slug, input.legalName, input.displayName, input.currency],
    );
    const tenantId = tenant.rows[0]!.id;
    const property = await client.query<{ id: string }>(
      `INSERT INTO properties (tenant_id, name, legal_name, timezone, currency_code, business_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenantId,
        input.propertyName,
        input.legalName,
        input.timezone,
        input.currency,
        todayIn(input.timezone),
      ],
    );
    const propertyId = property.rows[0]!.id;
    const owner = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, input.ownerEmail, input.ownerFullName, passwordHash],
    );
    const ownerUserId = owner.rows[0]!.id;
    await client.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1, $2, 'tenant_owner')`,
      [tenantId, ownerUserId],
    );
    await client.query(
      `INSERT INTO audit_events (tenant_id, property_id, actor_type, action, entity_type, entity_id, changes)
       VALUES ($1, $2, 'platform', 'tenant.created', 'tenant', $1, $3)`,
      [
        tenantId,
        propertyId,
        JSON.stringify({ slug: input.slug, propertyName: input.propertyName, ownerEmail: input.ownerEmail }),
      ],
    );
    await client.query('COMMIT');
    return { tenantId, propertyId, ownerUserId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const e = err as { code?: string; constraint?: string };
    if (e.code === UNIQUE_VIOLATION) {
      throw new TenantProvisioningError(
        e.constraint?.startsWith('tenants_')
          ? `A tenant with slug "${input.slug}" already exists.`
          : `The owner email ${input.ownerEmail} is already registered.`,
      );
    }
    throw err;
  } finally {
    await client.end();
  }
}
