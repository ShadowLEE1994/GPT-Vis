import { Client } from 'minio';

export interface OssConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  secure: boolean;
  port?: number;
  region?: string;
  pathStyle: boolean;
  cname?: boolean;
  objectPrefix?: string;
  cdnBaseUrl?: string;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return 'gpt-vis/';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function requiredField(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required OSS config: ${name}`);
  }
  return value;
}

function parsePort(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid OSS config: ${name} must be a valid port`);
  }
  return port;
}

function normalizeEndpoint(endpoint: string, secureHint: boolean): {
  endpoint: string;
  port?: number;
  secure: boolean;
} {
  const rawValue = endpoint.trim();
  if (!rawValue) {
    throw new Error('Missing required OSS config: OSS_ENDPOINT');
  }

  const endpointWithProtocol = rawValue.includes('://')
    ? rawValue
    : `${secureHint ? 'https' : 'http'}://${rawValue}`;

  let url: URL;
  try {
    url = new URL(endpointWithProtocol);
  } catch {
    throw new Error(`Invalid OSS endpoint: ${endpoint}`);
  }

  if (!url.hostname) {
    throw new Error(`Invalid OSS endpoint: ${endpoint}`);
  }

  if (url.pathname && url.pathname !== '/') {
    throw new Error('Invalid OSS endpoint: path is not supported, use host[:port] only');
  }

  return {
    endpoint: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    secure: url.protocol === 'https:',
  };
}

export function resolveOssConfig(
  payloadConfig?: Partial<OssConfig>,
  env: NodeJS.ProcessEnv = process.env,
  allowRequestConfig = false,
): OssConfig {
  const useRequestConfig = allowRequestConfig && payloadConfig ? payloadConfig : {};

  const secureHint =
    typeof useRequestConfig.secure === 'boolean'
      ? useRequestConfig.secure
      : parseBoolean(env.OSS_SECURE, true);
  const rawEndpoint = toStringOrUndefined(useRequestConfig.endpoint) || env.OSS_ENDPOINT;
  const normalizedEndpoint = normalizeEndpoint(requiredField('OSS_ENDPOINT', rawEndpoint), secureHint);
  const envPort = parsePort(env.OSS_PORT, 'OSS_PORT');
  const requestPort = typeof useRequestConfig.port === 'number' ? useRequestConfig.port : undefined;
  const bucket = toStringOrUndefined(useRequestConfig.bucket) || env.OSS_BUCKET;
  const accessKeyId =
    toStringOrUndefined(useRequestConfig.accessKeyId) || env.OSS_ACCESS_KEY_ID;
  const accessKeySecret =
    toStringOrUndefined(useRequestConfig.accessKeySecret) || env.OSS_ACCESS_KEY_SECRET;
  const region = toStringOrUndefined(useRequestConfig.region) || env.OSS_REGION;
  const objectPrefix =
    toStringOrUndefined(useRequestConfig.objectPrefix) || env.OSS_OBJECT_PREFIX;
  const cdnBaseUrl = toStringOrUndefined(useRequestConfig.cdnBaseUrl) || env.OSS_CDN_BASE_URL;
  const pathStyle =
    typeof useRequestConfig.pathStyle === 'boolean'
      ? useRequestConfig.pathStyle
      : parseBoolean(env.OSS_PATH_STYLE, true);
  const cname =
    typeof useRequestConfig.cname === 'boolean'
      ? useRequestConfig.cname
      : parseBoolean(env.OSS_CNAME, false);

  return {
    endpoint: normalizedEndpoint.endpoint,
    port: requestPort ?? envPort ?? normalizedEndpoint.port,
    bucket: requiredField('OSS_BUCKET', bucket),
    accessKeyId: requiredField('OSS_ACCESS_KEY_ID', accessKeyId),
    accessKeySecret: requiredField('OSS_ACCESS_KEY_SECRET', accessKeySecret),
    secure: normalizedEndpoint.secure,
    region,
    pathStyle,
    cname,
    objectPrefix,
    cdnBaseUrl,
  };
}

export function createOssClient(config: OssConfig): Client {
  return new Client({
    endPoint: config.endpoint,
    port: config.port,
    useSSL: config.secure,
    accessKey: config.accessKeyId,
    secretKey: config.accessKeySecret,
    region: config.region,
    pathStyle: config.pathStyle,
  });
}

export async function uploadObject(
  client: Client,
  config: OssConfig,
  objectKey: string,
  body: Buffer,
  contentType = 'image/png',
  cacheControl?: string,
): Promise<void> {
  const metadata: Record<string, string> = { 'Content-Type': contentType };
  if (cacheControl) metadata['Cache-Control'] = cacheControl;
  await client.putObject(config.bucket, objectKey, body, body.length, metadata);
}

export function toPublicUrl(config: OssConfig, objectKey: string): string {
  if (config.cdnBaseUrl) {
    const base = config.cdnBaseUrl.replace(/\/$/, '');
    return `${base}/${objectKey}`;
  }

  const protocol = config.secure ? 'https' : 'http';
  const authority = config.port ? `${config.endpoint}:${config.port}` : config.endpoint;

  if (config.cname) {
    return `${protocol}://${authority}/${objectKey}`;
  }

  if (config.pathStyle) {
    return `${protocol}://${authority}/${config.bucket}/${objectKey}`;
  }

  return `${protocol}://${config.bucket}.${authority}/${objectKey}`;
}
