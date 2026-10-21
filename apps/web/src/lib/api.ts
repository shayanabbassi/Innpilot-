import {
  CSRF_HEADER,
  csrfCookieName,
  platformCsrfCookieName,
  type ErrorBody,
  type ErrorCode,
  type FieldIssue,
  type SuccessBody,
} from '@innpilot/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details: FieldIssue[] = [],
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** The API sets a __Host- prefixed cookie over HTTPS and a plain one in local http development. */
function csrfToken(side: Side): string | null {
  const name = side === 'platform' ? platformCsrfCookieName : csrfCookieName;
  return readCookie(name(true)) ?? readCookie(name(false));
}

/** The hotel app and the operator console have separate sessions and CSRF cookies. */
type Side = 'tenant' | 'platform';

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
  side: Side = 'tenant',
): Promise<{ data: T; nextCursor: string | null }> {
  const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const token = csrfToken(side);
    if (token) headers[CSRF_HEADER] = token;
  }

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'INTERNAL_ERROR',
      'Cannot reach the server. Check your internet connection and try again.',
    );
  }

  const payload = (await res.json().catch(() => null)) as SuccessBody<T> | ErrorBody | null;
  if (!res.ok || !payload || 'error' in payload) {
    const err = payload && 'error' in payload ? payload : null;
    throw new ApiError(
      res.status,
      err?.error.code ?? 'INTERNAL_ERROR',
      err?.error.message ?? 'Something went wrong. Try again.',
      err?.error.details ?? [],
      err?.meta.requestId ?? res.headers.get('x-request-id'),
    );
  }
  return { data: payload.data, nextCursor: payload.meta.nextCursor ?? null };
}

export const api = {
  get: async <T>(path: string) => (await request<T>('GET', path)).data,
  page: async <T>(path: string): Promise<Paged<T>> => {
    const { data, nextCursor } = await request<T[]>('GET', path);
    return { items: data, nextCursor };
  },
  post: async <T>(path: string, body: unknown = {}) => (await request<T>('POST', path, body)).data,
  /** POST with extra headers, e.g. an Idempotency-Key for retry-safe commands. */
  postWith: async <T>(path: string, body: unknown, headers: Record<string, string>) =>
    (await request<T>('POST', path, body, headers)).data,
  put: async <T>(path: string, body: unknown) => (await request<T>('PUT', path, body)).data,
  patch: async <T>(path: string, body: unknown) => (await request<T>('PATCH', path, body)).data,
  del: async <T>(path: string) => (await request<T>('DELETE', path)).data,
  /** A file download (report exports). Errors come back as the usual JSON error and are thrown as ApiError. */
  download: async (path: string): Promise<{ blob: Blob; fileName: string }> => {
    let res: Response;
    try {
      res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
    } catch {
      throw new ApiError(
        0,
        'INTERNAL_ERROR',
        'Cannot reach the server. Check your internet connection and try again.',
      );
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as ErrorBody | null;
      throw new ApiError(
        res.status,
        err?.error.code ?? 'INTERNAL_ERROR',
        err?.error.message ?? 'Something went wrong. Try again.',
        err?.error.details ?? [],
        err?.meta.requestId ?? res.headers.get('x-request-id'),
      );
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export';
    return { blob: await res.blob(), fileName: name };
  },
};

/** The operator console (slice 5.7): operator session and CSRF cookie, never the hotel ones. */
export const platformApi = {
  get: async <T>(path: string) => (await request<T>('GET', path, undefined, {}, 'platform')).data,
  post: async <T>(path: string, body: unknown = {}) =>
    (await request<T>('POST', path, body, {}, 'platform')).data,
  patch: async <T>(path: string, body: unknown) =>
    (await request<T>('PATCH', path, body, {}, 'platform')).data,
};
