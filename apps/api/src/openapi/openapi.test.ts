import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, ROUTE_DOCS } from './document';
import { collectRoutes } from './routes';

const FILE = join(__dirname, '..', '..', '..', '..', 'docs', 'openapi', 'openapi.json');

describe('OpenAPI contract', () => {
  it('documents exactly the routes the API implements', () => {
    const implemented = collectRoutes()
      .map((r) => r.key)
      .sort();
    expect(Object.keys(ROUTE_DOCS).sort()).toEqual(implemented);
  });

  it('is up to date in docs/openapi/openapi.json (run "pnpm --filter @innpilot/api openapi")', () => {
    expect(existsSync(FILE)).toBe(true);
    const committed: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it('describes each route’s access policy from the code', () => {
    const doc = buildOpenApiDocument();
    expect(doc.paths?.['/users']?.post?.description).toContain('`user.manage` from a tenant-wide role');
    expect(doc.paths?.['/properties/{id}']?.patch?.description).toContain(
      '`property.manage` on the property',
    );
    expect(doc.paths?.['/auth/login']?.post?.security).toEqual([]);
  });
});
