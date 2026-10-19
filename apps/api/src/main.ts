import { loadRootEnv } from '@innpilot/db';
import { createApp } from './bootstrap';
import { loadConfig } from './config';

async function main(): Promise<void> {
  loadRootEnv();
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.API_PORT);
}

main().catch((err: unknown) => {
  // Logger may not exist yet if configuration failed.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
