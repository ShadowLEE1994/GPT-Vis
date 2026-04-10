# gpt-vis-ssr

`Render` [GPT-Vis](https://github.com/antvis/GPT-Vis) in Server-Side with NodeJS.

## Installation

```sh
npm install --save @antv/gpt-vis-ssr
```

## Usage

```js
import { render } from '@antv/gpt-vis-ssr';

const options = {
  type: 'line',
  data: [
    { time: 2018, value: 91.9 },
    { time: 2019, value: 99.1 },
    { time: 2020, value: 101.6 },
    { time: 2021, value: 114.4 },
    { time: 2022, value: 121 },
  ],
};

const vis = await render(options);

const buffer = vis.toBuffer();

// You need to destroy the SSRResult when you are done with it to free up resources.
vis.destroy();
```

## API

### `render(options: Options): SSRResult`

Render spec into image buffer in NodeJS.

```ts
type SSRResult = {
  toBuffer: (meta?: any) => Buffer;
  destroy: () => void;
};
```

## OSS Server Entry (Dify-Compatible)

This repository now includes a server entry at `server/oss-server.ts`.

- Route: `POST /api/gpt-vis`
- Health check: `GET /health`
- Response format is compatible with dify plugin style:

```json
{
  "success": true,
  "resultObj": "https://your-cdn-or-oss-url/xxx.png",
  "objectKey": "gpt-vis/2026-04-02/uuid.png"
}
```

### 1. Install and run

```sh
pnpm install
# This command builds the package and server, then starts the OSS server.
pnpm dev:oss-server
```

### 2. Configure OSS

Copy `.env.example` and set required fields:

- `OSS_ENDPOINT`
- `OSS_BUCKET`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`

Optional fields:

- `OSS_REGION`
- `OSS_PORT`
- `OSS_SECURE`
- `OSS_PATH_STYLE`
- `OSS_CNAME`
- `OSS_OBJECT_PREFIX`
- `OSS_CDN_BASE_URL`
- `ALLOW_REQUEST_OSS_CONFIG`

This server now uses the open source `minio` client, which is compatible with S3-style object storage services. It is better suited for Tianyi Cloud OSS and other non-Aliyun endpoints because it does not require Aliyun-style `region` validation.

`ALLOW_REQUEST_OSS_CONFIG=false` by default for security.

### 3. Request example

```bash
curl -X POST 'http://localhost:7001/api/gpt-vis' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "bar",
    "width": 600,
    "height": 400,
    "data": [
      { "name": "A", "value": 10 },
      { "name": "B", "value": 22 }
    ],
    "source": "custom-platform"
  }'
```

When `ALLOW_REQUEST_OSS_CONFIG=true`, you can pass `ossConfig` in request body to override env config:

```json
{
  "type": "line",
  "data": [{ "time": "2024", "value": 100 }],
  "ossConfig": {
    "endpoint": "obs-cn-east-1.ctyun.cn",
    "bucket": "your-bucket",
    "accessKeyId": "your-ak",
    "accessKeySecret": "your-sk",
    "pathStyle": true,
    "objectPrefix": "custom-prefix",
    "cdnBaseUrl": "https://cdn.example.com"
  }
}
```

## Docker Deployment

### Build image locally

```bash
cd bindings/gpt-vis-ssr

# Apple Silicon (M1/M2/M3) — cross-compile to amd64
docker buildx build --platform linux/amd64 --load -t gpt-vis-ssr:latest .

# Intel Mac — build directly
docker build -t gpt-vis-ssr:latest .
```

### Export and transfer to server

```bash
docker save gpt-vis-ssr:latest | gzip > gpt-vis-ssr.tar.gz
scp gpt-vis-ssr.tar.gz user@your-server:/opt/gpt-vis-ssr/
```

### Load and start on server

```bash
# Load image
docker load < gpt-vis-ssr.tar.gz

# Start with env vars
docker run -d \
  -p 7001:7001 \
  -e OSS_ENDPOINT=obs-cn-east-1.ctyun.cn \
  -e OSS_BUCKET=your-bucket \
  -e OSS_ACCESS_KEY_ID=your-key \
  -e OSS_ACCESS_KEY_SECRET=your-secret \
  --name gpt-vis-ssr \
  gpt-vis-ssr:latest

# Or start with .env file
docker run -d -p 7001:7001 --env-file .env --name gpt-vis-ssr gpt-vis-ssr:latest
```

## License

[MIT](./LICENSE)
