import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import busboy from 'busboy';
import { config as loadEnv } from 'dotenv';
import { render } from '../src';
import type { Options } from '../src/types';
import { createOssClient, normalizePrefix, resolveOssConfig, toPublicUrl, uploadObject } from './oss-client';

// 自动加载运行目录下的 .env 文件（文件不存在时静默跳过）
loadEnv();

interface RequestPayload {
  type: string;
  ossConfig?: Record<string, unknown>;
  source?: string;
  [key: string]: unknown;
}

const PORT = Number(process.env.PORT || 7001);
const MAX_BODY_SIZE = Number(process.env.MAX_BODY_SIZE || 1024 * 1024);
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE || 100 * 1024 * 1024); // 默认 50MB
const ALLOW_REQUEST_OSS_CONFIG = process.env.ALLOW_REQUEST_OSS_CONFIG === 'true';
// 单次渲染 + 上传的最长等待时间（毫秒），超时后返回 500
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 60_000);

// ─── 进程级防崩 ────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[gpt-vis-ssr] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[gpt-vis-ssr] Uncaught exception:', err);
});

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function logError(label: string, error: unknown, extra?: Record<string, unknown>): void {
  if (extra) {
    console.error(`[gpt-vis-ssr] ${label}`, extra, error);
  } else {
    console.error(`[gpt-vis-ssr] ${label}`, error);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<RequestPayload> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error(`Payload too large. Limit: ${MAX_BODY_SIZE} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        if (!raw) {
          throw new Error('Request body is empty');
        }
        const json = JSON.parse(raw) as RequestPayload;
        if (!json.type || typeof json.type !== 'string') {
          throw new Error('`type` is required and must be a string');
        }
        resolve(json);
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    sendJson(res, 415, { success: false, errorMessage: 'Content-Type must be multipart/form-data' });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let totalSize = 0;
    let fileReceived = false;
    let ossConfigRaw: string | undefined;
    let customFilename: string | undefined;

    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_SIZE } });

    bb.on('field', (name, value) => {
      if (name === 'ossConfig') ossConfigRaw = value;
      if (name === 'filename') customFilename = value;
    });

    bb.on('file', (name, stream, info) => {
      if (fileReceived) {
        // 只处理第一个文件
        stream.resume();
        return;
      }
      fileReceived = true;

      const { filename, mimeType } = info;
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_UPLOAD_SIZE) {
          bb.destroy(new Error(`File too large. Limit: ${MAX_UPLOAD_SIZE} bytes`));
          return;
        }
        chunks.push(chunk);
      });

      stream.on('limit', () => {
        bb.destroy(new Error(`File too large. Limit: ${MAX_UPLOAD_SIZE} bytes`));
      });

      stream.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const rawName = customFilename || filename || `file-${randomUUID()}`;
          const safeFilename = rawName.replace(/[^\w.\-]/g, '_');
          // 若文件名无扩展名，尝试从 mimeType 推断
          const mimeToExt: Record<string, string> = {
            'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
            'image/webp': '.webp', 'image/svg+xml': '.svg',
            'application/pdf': '.pdf',
            'application/json': '.json',
            'text/plain': '.txt', 'text/csv': '.csv', 'text/html': '.html',
            'application/zip': '.zip', 'application/gzip': '.gz',
            'video/mp4': '.mp4', 'video/webm': '.webm',
            'audio/mpeg': '.mp3', 'audio/wav': '.wav',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
          };
          const ext = safeFilename.includes('.') ? '' : (mimeToExt[mimeType] ?? '');
          const resolvedOssConfig = ossConfigRaw ? (() => {
            try { return JSON.parse(ossConfigRaw) as Record<string, unknown>; } catch { return undefined; }
          })() : undefined;

          const config = resolveOssConfig(resolvedOssConfig, process.env, ALLOW_REQUEST_OSS_CONFIG);
          const client = createOssClient(config);

          const now = new Date();
          const datePath = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
          const objectKey = `${normalizePrefix(config.objectPrefix)}${datePath}/${randomUUID()}-${safeFilename}${ext}`;

          // 图片类型设置长期缓存，其他类型不强制缓存
          const isImage = (mimeType || '').startsWith('image/');
          const cacheControl = isImage ? 'public, max-age=31536000' : undefined;
          await uploadObject(client, config, objectKey, buffer, mimeType || 'application/octet-stream', cacheControl);

          const fileUrl = toPublicUrl(config, objectKey);
          console.log(`[gpt-vis-ssr] File uploaded: ${fileUrl}`);

          sendJson(res, 200, { success: true, resultObj: fileUrl, objectKey });
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    bb.on('error', reject);

    bb.on('finish', () => {
      if (!fileReceived) {
        reject(new Error('No file field found in the request'));
      }
    });

    req.pipe(bb);
  });
}

async function handleRender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await readJsonBody(req);
  const { ossConfig, source, ...chartOptions } = payload;

  let vis: Awaited<ReturnType<typeof render>> | undefined;
  try {
    vis = await render(chartOptions as Options);
    const buffer = vis.toBuffer();
    const config = resolveOssConfig(ossConfig, process.env, ALLOW_REQUEST_OSS_CONFIG);
    const client = createOssClient(config);

    const now = new Date();
    const datePath = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(
      now.getUTCDate(),
    ).padStart(2, '0')}`;
    const objectKey = `${normalizePrefix(config.objectPrefix)}${datePath}/${randomUUID()}.png`;

    try {
      await uploadObject(client, config, objectKey, buffer, 'image/png', 'public, max-age=31536000');
    } catch (ossErr: unknown) {
      logError('OSS upload failed:', ossErr, {
        objectKey,
        bucket: config.bucket,
        endpoint: config.endpoint,
      });
      throw ossErr;
    }

    const imageUrl = toPublicUrl(config, objectKey);
    console.log(`[gpt-vis-ssr] Rendered and uploaded: ${imageUrl}`);

    sendJson(res, 200, {
      success: true,
      resultObj: imageUrl,
      objectKey,
      source: source || 'custom-server',
    });
  } finally {
    vis?.destroy();
  }
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { success: false, errorMessage: 'Invalid request' });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { success: true, message: 'ok' });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/upload') {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      logError('Upload request timed out after', REQUEST_TIMEOUT, { url: req.url });
      sendJson(res, 504, { success: false, errorMessage: `Request timed out after ${REQUEST_TIMEOUT}ms` });
    }, REQUEST_TIMEOUT);

    try {
      await handleUpload(req, res);
    } catch (error) {
      if (!timedOut) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logError('Upload failed:', error);
        sendJson(res, 500, { success: false, errorMessage: message });
      }
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/gpt-vis') {
    // Content-Type 校验
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      sendJson(res, 415, { success: false, errorMessage: 'Content-Type must be application/json' });
      return;
    }

    // 请求超时保护
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      logError('Request timed out after', REQUEST_TIMEOUT, { url: req.url });
      sendJson(res, 504, { success: false, errorMessage: `Request timed out after ${REQUEST_TIMEOUT}ms` });
    }, REQUEST_TIMEOUT);

    try {
      await handleRender(req, res);
    } catch (error) {
      if (!timedOut) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logError('Render failed:', error);
        sendJson(res, 500, { success: false, errorMessage: message });
      }
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  sendJson(res, 404, { success: false, errorMessage: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`[gpt-vis-ssr] OSS server listening on http://localhost:${PORT}`);
  console.log('[gpt-vis-ssr] POST /api/gpt-vis, POST /api/upload and GET /health are available.');
  if (!ALLOW_REQUEST_OSS_CONFIG) {
    console.log('[gpt-vis-ssr] Request-level ossConfig is disabled. Set ALLOW_REQUEST_OSS_CONFIG=true to enable it.');
  }
});

function shutdown(signal: string) {
  console.log(`[gpt-vis-ssr] Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    console.log('[gpt-vis-ssr] Server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
