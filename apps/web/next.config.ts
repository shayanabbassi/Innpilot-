import { join } from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

const production = process.env.NODE_ENV === 'production';

/**
 * Content Security Policy (P6-5): only this origin's scripts, styles, images and API. Next.js still needs inline
 * scripts for hydration ('unsafe-inline'; nonces are a later hardening step), and the dev server needs eval, so the
 * policy applies to production builds only.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(production
    ? [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
      ]
    : []),
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A self-contained server for the production image (apps/web/Dockerfile sets NEXT_STANDALONE), traced from the
  // repository root so the workspace packages are included. Off elsewhere: on Windows it needs symlink rights.
  ...(process.env.NEXT_STANDALONE === '1'
    ? { output: 'standalone' as const, outputFileTracingRoot: join(__dirname, '..', '..') }
    : {}),
  // Lint runs as its own CI step with the repository ESLint config.
  eslint: { ignoreDuringBuilds: true },
  // The browser talks to one origin; /api is proxied to the API so cookies stay first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(config);
