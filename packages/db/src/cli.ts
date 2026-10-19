/* eslint-disable no-console -- command-line entry point */
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { migrate, provisionAppRole } from './migrate';
import { seed } from './seed';
import { createTenant, TenantProvisioningError } from './tenants';
import { loadRootEnv } from './testing';

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

/** Reads the owner password from piped stdin, or prompts without echoing it. Never from argv. */
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += String(chunk);
    return data.replace(/\r?\n$/, '');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
  let prompting = true;
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (!prompting || s.startsWith('Owner password')) write(s);
  };
  return new Promise((resolve) => {
    rl.question('Owner password (min 12 characters): ', (answer) => {
      prompting = false;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const TENANT_USAGE = `Usage: pnpm tenant:create --slug <slug> --legal-name <name> --display-name <name>
       --property <name> --owner-email <email> --owner-name <name> [--timezone Asia/Karachi]
The owner password is prompted for (or read from stdin), never passed as an argument.`;

async function tenantCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      slug: { type: 'string' },
      'legal-name': { type: 'string' },
      'display-name': { type: 'string' },
      property: { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-name': { type: 'string' },
      timezone: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(TENANT_USAGE);
    return;
  }
  const missing = ['slug', 'legal-name', 'display-name', 'property', 'owner-email', 'owner-name'].filter(
    (k) => !values[k as keyof typeof values],
  );
  if (missing.length) {
    console.error(`Missing: ${missing.map((m) => `--${m}`).join(', ')}\n${TENANT_USAGE}`);
    process.exit(1);
  }
  const created = await createTenant(env('DATABASE_ADMIN_URL'), {
    slug: values.slug!,
    legalName: values['legal-name']!,
    displayName: values['display-name']!,
    propertyName: values.property!,
    ownerEmail: values['owner-email']!,
    ownerFullName: values['owner-name']!,
    ...(values.timezone ? { timezone: values.timezone } : {}),
    ownerPassword: await readPassword(),
  });
  console.log(`Created tenant ${values.slug} (${created.tenantId}).`);
  console.log(`The owner can now sign in as ${values['owner-email']} and will be guided through setup.`);
}

async function main(command: string | undefined, rest: string[]): Promise<void> {
  loadRootEnv();
  switch (command) {
    case 'provision':
      await provisionAppRole(env('DATABASE_ADMIN_URL'), env('APP_DB_PASSWORD'));
      console.log('Application role innpilot_app is ready.');
      return;
    case 'migrate': {
      const { applied, alreadyApplied } = await migrate(env('DATABASE_ADMIN_URL'));
      console.log(
        `Applied ${applied.length} migration(s)${applied.length ? `: ${applied.join(', ')}` : ''}.`,
      );
      console.log(`${alreadyApplied.length} already applied.`);
      return;
    }
    case 'seed': {
      const created = await seed(env('DATABASE_ADMIN_URL'), env('SEED_USER_PASSWORD'));
      console.log(
        created.length ? `Seeded demo tenants: ${created.join(', ')}.` : 'Demo tenants already exist.',
      );
      return;
    }
    case 'tenant:create':
      await tenantCreate(rest);
      return;
    default:
      console.error('Usage: cli <provision|migrate|seed|tenant:create>');
      process.exit(1);
  }
}

main(process.argv[2], process.argv.slice(3)).catch((err: unknown) => {
  console.error(err instanceof TenantProvisioningError || err instanceof Error ? err.message : err);
  process.exit(1);
});
