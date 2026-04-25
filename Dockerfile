# syntax=docker/dockerfile:1.6

############################
# 1) 依赖安装层（Node deps）
############################
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

############################
# 2) 构建层（Next build）
############################
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

############################
# 3) 运行层（Node + Python）
############################
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PYTHON_PATH=python3 \
    PORT=3000

# Python 运行时（ccxt/pandas/numpy）
RUN apk add --no-cache python3 py3-pip tini ca-certificates \
    && python3 -m pip install --break-system-packages --no-cache-dir \
       ccxt pandas numpy certifi

# Next.js standalone 产物
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# 业务代码（standalone 不会把 python/ 和 data/ 打进去）
COPY --from=builder /app/modules ./modules
COPY --from=builder /app/python ./python
COPY --from=builder /app/data ./data
COPY --from=builder /app/eval ./eval
COPY --from=builder /app/scripts ./scripts

RUN mkdir -p /app/.live /app/modules/sentiment_momentum/logs \
    && chmod 700 /app/.live \
    && chmod +x /app/scripts/*.sh

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "/app/scripts/start.sh"]
