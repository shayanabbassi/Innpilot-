import { type RoleCode } from '@innpilot/contracts';
import { Client } from 'pg';
import { hashPassword } from './password';

/**
 * Fictional development data: two tenants so isolation can be seen in the UI.
 * Emails use the reserved .test domain. No real guests, hotels or credentials.
 */
interface SeedTenant {
  slug: string;
  legalName: string;
  displayName: string;
  property: { name: string; city: string; addressLine: string };
  users: { email: string; fullName: string; role: RoleCode }[];
}

export const SEED_TENANTS: SeedTenant[] = [
  {
    slug: 'demo-ravi',
    legalName: 'Ravi Demo Hospitality (Pvt) Ltd',
    displayName: 'Ravi Demo Hotel',
    property: { name: 'Ravi Demo Hotel', city: 'Lahore', addressLine: '1 Demo Road' },
    users: [
      { email: 'owner@ravi.demo.test', fullName: 'Ayesha Demo (Owner)', role: 'tenant_owner' },
      { email: 'manager@ravi.demo.test', fullName: 'Bilal Demo (Manager)', role: 'hotel_manager' },
      { email: 'accounts@ravi.demo.test', fullName: 'Sana Demo (Accountant)', role: 'accountant' },
      { email: 'cashier@ravi.demo.test', fullName: 'Hamza Demo (Cashier)', role: 'cashier' },
      { email: 'frontdesk@ravi.demo.test', fullName: 'Zara Demo (Front desk)', role: 'front_desk' },
      { email: 'housekeeping@ravi.demo.test', fullName: 'Imran Demo (Housekeeping)', role: 'housekeeping' },
      { email: 'auditor@ravi.demo.test', fullName: 'Nadia Demo (Auditor)', role: 'read_only_auditor' },
    ],
  },
  {
    slug: 'demo-kohsar',
    legalName: 'Kohsar Demo Guest House',
    displayName: 'Kohsar Demo Guest House',
    property: { name: 'Kohsar Demo Guest House', city: 'Islamabad', addressLine: '2 Sample Street' },
    users: [
      { email: 'owner@kohsar.demo.test', fullName: 'Omar Demo (Owner)', role: 'tenant_owner' },
      { email: 'frontdesk@kohsar.demo.test', fullName: 'Hina Demo (Front desk)', role: 'front_desk' },
    ],
  },
];

/** Today's date in a time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Inserts the demo tenants if missing. Runs with the admin connection (bypasses RLS). */
export async function seed(adminUrl: string, password: string): Promise<string[]> {
  if (password.length < 12) throw new Error('SEED_USER_PASSWORD must be at least 12 characters.');
  const passwordHash = await hashPassword(password);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  const created: string[] = [];
  try {
    for (const t of SEED_TENANTS) {
      const exists = await client.query('SELECT 1 FROM tenants WHERE slug = $1', [t.slug]);
      if (exists.rowCount) continue;
      await client.query('BEGIN');
      const {
        rows: [tenant],
      } = await client.query<{ id: string }>(
        `INSERT INTO tenants (slug, legal_name, display_name, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
        [t.slug, t.legalName, t.displayName],
      );
      await client.query(
        `INSERT INTO properties (tenant_id, name, city, address_line, business_date)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenant!.id, t.property.name, t.property.city, t.property.addressLine, todayIn('Asia/Karachi')],
      );
      for (const u of t.users) {
        const {
          rows: [user],
        } = await client.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenant!.id, u.email, u.fullName, passwordHash],
        );
        await client.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1, $2, $3)`, [
          tenant!.id,
          user!.id,
          u.role,
        ]);
      }
      await client.query('COMMIT');
      created.push(t.slug);
    }
    return created;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
