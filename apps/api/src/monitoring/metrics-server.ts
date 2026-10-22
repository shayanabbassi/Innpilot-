import { createServer, type Server } from 'node:http';
import type { MetricsService } from './metrics.service';

/**
 * Serves GET /metrics on its own port (METRICS_PORT), separate from the API's public port: the reverse proxy only
 * routes /api to the API, so metrics are reachable from the private network (the Prometheus scraper) and nowhere
 * else.
 */
export function startMetricsServer(metrics: MetricsService, port: number, host = '0.0.0.0'): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metrics
      .render()
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }).end(body);
      })
      .catch(() => res.writeHead(500).end());
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
