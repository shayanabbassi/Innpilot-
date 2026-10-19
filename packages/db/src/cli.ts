/* eslint-disable no-console -- command-line entry point */
import { migrate, provisionAppRole } from './migrate';
import { seed } from './seed';
import { loadRootEnv } from './testing';

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

async function main(command: string | undefined): Promise<void> {
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
    default:
      console.error('Usage: cli <provision|migrate|seed>');
      process.exit(1);
  }
}

main(process.argv[2]).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
