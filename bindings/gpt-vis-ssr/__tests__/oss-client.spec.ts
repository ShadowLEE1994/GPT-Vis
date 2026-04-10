import { describe, expect, it } from '@jest/globals';
import { normalizePrefix, resolveOssConfig, toPublicUrl } from '../server/oss-client';

describe('oss-client', () => {
  it('resolves endpoint-first config for S3 compatible storage', () => {
    const config = resolveOssConfig(
      undefined,
      {
        OSS_ENDPOINT: 'https://obs-cn-east-1.ctyun.cn',
        OSS_BUCKET: 'demo-bucket',
        OSS_ACCESS_KEY_ID: 'ak',
        OSS_ACCESS_KEY_SECRET: 'sk',
        OSS_PATH_STYLE: 'true',
      },
      false,
    );

    expect(config.endpoint).toBe('obs-cn-east-1.ctyun.cn');
    expect(config.secure).toBe(true);
    expect(config.pathStyle).toBe(true);
    expect(config.region).toBeUndefined();
  });

  it('allows request config override when enabled', () => {
    const config = resolveOssConfig(
      {
        endpoint: 'http://gateway.example.com:9000',
        pathStyle: false,
      },
      {
        OSS_ENDPOINT: 'https://ignored.example.com',
        OSS_BUCKET: 'demo-bucket',
        OSS_ACCESS_KEY_ID: 'ak',
        OSS_ACCESS_KEY_SECRET: 'sk',
      },
      true,
    );

    expect(config.endpoint).toBe('gateway.example.com');
    expect(config.port).toBe(9000);
    expect(config.secure).toBe(false);
    expect(config.pathStyle).toBe(false);
  });

  it('builds path-style public url by default', () => {
    const url = toPublicUrl(
      {
        endpoint: 'obs-cn-east-1.ctyun.cn',
        bucket: 'demo-bucket',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
        secure: true,
        pathStyle: true,
      },
      'gpt-vis/2026-04-08/demo.png',
    );

    expect(url).toBe('https://obs-cn-east-1.ctyun.cn/demo-bucket/gpt-vis/2026-04-08/demo.png');
  });

  it('normalizes object prefix', () => {
    expect(normalizePrefix(undefined)).toBe('gpt-vis/');
    expect(normalizePrefix('custom-prefix')).toBe('custom-prefix/');
  });
});
