import { createHash, createHmac } from 'node:crypto';

/**
 * A minimal S3 client: the four calls the attachment store needs, signed with AWS Signature Version 4 and
 * path-style addressing, so it works with any S3-compatible service (the cloud provider's, or the local
 * container). No SDK: a few dozen lines that are easy to audit.
 */

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignInput {
  method: string;
  host: string;
  /** Already URI-encoded path, e.g. /bucket/a/b. */
  path: string;
  /** Query parameters, unencoded (e.g. list-type=2). */
  query?: Record<string, string>;
  /** Lower-case header names; host, x-amz-date and x-amz-content-sha256 are added. */
  headers?: Record<string, string>;
  payloadHash: string;
  /** e.g. 20130524T000000Z */
  amzDate: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding of one path segment, as SigV4 requires. */
export function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Query string in SigV4 canonical form: names sorted, names and values RFC 3986 encoded. */
export function canonicalQueryString(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${encodeSegment(k)}=${encodeSegment(query[k]!)}`)
    .join('&');
}

/** The headers to send, including Authorization. Exported for the signing test. */
export function signRequest(input: SignInput): Record<string, string> {
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': input.amzDate,
  };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
  const canonicalQuery = canonicalQueryString(input.query ?? {});
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** A storage call that failed for a reason other than "not found". */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export class S3Client {
  constructor(
    private readonly s: S3Settings,
    private readonly timeoutMs = 15_000,
  ) {}

  /** Stores an object, replacing any object with the same key. */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.send('PUT', key, body, { 'content-type': contentType });
    if (!res.ok) throw await this.failure('PUT', res);
  }

  /** The object's bytes, or null if there is no such object. */
  async get(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.failure('GET', res);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Deleting a missing object succeeds (S3 semantics). */
  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    if (!res.ok && res.status !== 404) throw await this.failure('DELETE', res);
  }

  /** Every object key under `prefix`, following continuation pages. */
  async list(prefix: string): Promise<{ key: string; size: number; lastModified: string }[]> {
    const out: { key: string; size: number; lastModified: string }[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const res = await this.send('GET', null, undefined, {}, query);
      if (!res.ok) throw await this.failure('LIST', res);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const part = m[1]!;
        const key = /<Key>([^<]*)<\/Key>/.exec(part)?.[1];
        if (!key) continue;
        out.push({
          key: decodeXml(key),
          size: Number(/<Size>(\d+)<\/Size>/.exec(part)?.[1] ?? 0),
          lastModified: /<LastModified>([^<]*)<\/LastModified>/.exec(part)?.[1] ?? '',
        });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? decodeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') ||
          undefined
        : undefined;
    } while (token);
    return out;
  }

  /** True if the bucket exists and these credentials can reach it. */
  async bucketExists(): Promise<boolean> {
    const res = await this.send('HEAD', null);
    if (res.status === 404) return false;
    if (!res.ok) throw await this.failure('HEAD', res);
    return true;
  }

  async createBucket(): Promise<void> {
    const res = await this.send('PUT', null);
    // 409: someone else created it in the meantime.
    if (!res.ok && res.status !== 409) throw await this.failure('CREATE', res);
  }

  private async send(
    method: string,
    key: string | null,
    body?: Buffer,
    extra: Record<string, string> = {},
    query: Record<string, string> = {},
  ): Promise<Response> {
    const url = new URL(this.s.endpoint);
    const basePath = url.pathname.replace(/\/+$/, '');
    const path =
      `${basePath}/${encodeSegment(this.s.bucket)}` +
      (key === null ? '' : `/${key.split('/').map(encodeSegment).join('/')}`);
    const amzDate = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const headers = signRequest({
      method,
      host: url.host,
      path,
      query,
      headers: extra,
      payloadHash: hex(body ?? Buffer.alloc(0)),
      amzDate,
      region: this.s.region,
      accessKeyId: this.s.accessKeyId,
      secretAccessKey: this.s.secretAccessKey,
    });
    // fetch sets Host itself from the URL; sending it explicitly is not allowed.
    delete headers.host;
    try {
      const qs = canonicalQueryString(query);
      return await fetch(`${url.protocol}//${url.host}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new StorageError(`storage ${method} failed: ${err instanceof Error ? err.name : 'error'}`, null);
    }
  }

  private async failure(op: string, res: Response): Promise<StorageError> {
    // S3 error bodies are XML with a <Code>; keep only the code, never the full body.
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? 'unknown';
    return new StorageError(`storage ${op} returned ${res.status} (${code})`, res.status);
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
