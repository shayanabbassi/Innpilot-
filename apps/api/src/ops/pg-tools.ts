import { spawn } from 'node:child_process';

/**
 * Runs pg_dump / pg_restore with the connection in PG* environment variables (never on the command line, where
 * other processes could read the password).
 *
 * PG_TOOLS_CONTAINER (local development only) runs the tool inside that Docker container instead, for machines
 * without PostgreSQL client tools; the connection must then be reachable from inside the container.
 */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

export function runPgTool(
  tool: 'pg_dump' | 'pg_restore',
  args: string[],
  url: string,
  stdin?: Buffer,
): Promise<Buffer> {
  const env = pgEnv(url);
  const container = process.env.PG_TOOLS_CONTAINER;
  const child = container
    ? spawn(
        'docker',
        [
          'exec',
          '-i',
          ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
          container,
          tool,
          ...args,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
    : spawn(tool, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      // The tools never print the password, but strip it anyway before the message goes to a log.
      const message = Buffer.concat(err).toString('utf8').split(env.PGPASSWORD!).join('***').slice(-2000);
      reject(new Error(`${tool} exited with ${code}: ${message.trim()}`));
    });
    child.stdin.end(stdin ?? Buffer.alloc(0));
  });
}
