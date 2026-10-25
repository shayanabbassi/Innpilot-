import { loadRootEnv } from '@innpilot/db';
import { createApp } from './bootstrap';
import { loadConfig } from './config';
import { Db } from './db/db.module';
import { assertRestrictedDatabaseRole } from './db/role-check';
import { MetricsService } from './monitoring/metrics.service';
import { startMetricsServer } from './monitoring/metrics-server';

async function main(): Promise<void> {
  loadRootEnv();
  const config = loadConfig();
  const app = await createApp(config);
  if (config.NODE_ENV === 'production') await assertRestrictedDatabaseRole(app.get(Db).unscoped);
  await app.listen(config.API_PORT);
  if (config.METRICS_PORT > 0) await startMetricsServer(app.get(MetricsService), config.METRICS_PORT);
}

main().catch((err: unknown) => {
  // Logger may not exist yet if configuration failed.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
