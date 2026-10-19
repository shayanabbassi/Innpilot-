/* eslint-disable no-console -- command-line entry point */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildOpenApiDocument } from './document';

export const OPENAPI_FILE = join(__dirname, '..', '..', '..', '..', 'docs', 'openapi', 'openapi.json');

mkdirSync(dirname(OPENAPI_FILE), { recursive: true });
writeFileSync(OPENAPI_FILE, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`Wrote ${OPENAPI_FILE}`);
