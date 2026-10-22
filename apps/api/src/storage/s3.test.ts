import { describe, expect, it } from 'vitest';
import { encodeSegment, signRequest } from './s3';

describe('SigV4 signing', () => {
  it('matches the GET Object example in the AWS S3 signing documentation', () => {
    const headers = signRequest({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      amzDate: '20130524T000000Z',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('encodes path segments the way S3 expects', () => {
    expect(encodeSegment("a b(1)!*'.pdf")).toBe('a%20b%281%29%21%2A%27.pdf');
  });
});
