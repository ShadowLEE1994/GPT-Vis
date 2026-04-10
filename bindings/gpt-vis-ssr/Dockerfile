# ─────────────────────────────────────────
# Stage 1: builder — compile TypeScript
# ─────────────────────────────────────────
FROM node:20-bookworm AS builder

# canvas 原生依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 先复制 package 文件，利用缓存层
COPY package.json ./

RUN npm install --include=dev

# 复制源码并编译
COPY tsconfig.json tsconfig.server.json ./
COPY src/ ./src/
COPY server/ ./server/

RUN npm run build && npm run build:server

# ─────────────────────────────────────────
# Stage 2: runtime — 仅包含运行时依赖
# ─────────────────────────────────────────
FROM node:20-bookworm AS runtime

# canvas 运行时系统库
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

# 仅安装生产依赖，重新构建 canvas 原生模块
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  && npm install --omit=dev \
  && apt-get purge -y python3 make g++ libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# 从 builder 复制编译产物
COPY --from=builder /build/dist ./dist

# 运行时以非 root 用户启动（安全实践）
RUN useradd -m -u 1001 appuser
USER appuser

EXPOSE 7001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7001/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/server/oss-server.js"]
