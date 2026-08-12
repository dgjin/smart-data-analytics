# ---- 构建阶段：前端 Vite 产物 + 服务端 esbuild 打包 ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* bun.lock* ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---- 运行阶段：仅保留生产依赖与构建产物 ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# 生产环境必须注入的环境变量（容器不内置任何密钥）：
#   JWT_SECRET        JWT 签名密钥（缺失时拒绝启动，fail-fast）
#   DS_SECRET_KEY     数据源凭据加密密钥（可选，缺省回退 JWT_SECRET）
#   MYSQL_HOST/PORT/USER/PASSWORD/DATABASE  应用自身元数据库
#   GEMINI_API_KEY 或 OLLAMA_URL + LLM_MODEL  LLM 通道二选一
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.cjs"]
