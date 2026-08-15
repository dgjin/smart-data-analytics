# syntax=docker/dockerfile:1
# P2-3 部署形态：多阶段构建（构建期带 devDependencies 编译前端 + bundle server.cjs，运行期仅装生产依赖）
#
# 构建与运行：
#   docker build -t smart-data-analytics .
#   docker run -d -p 3000:3000 \
#     -e JWT_SECRET=<生产密钥> \
#     -e MYSQL_HOST=<数据库地址> -e MYSQL_PORT=3306 \
#     -e MYSQL_USER=<账号> -e MYSQL_PASSWORD=<密码> -e MYSQL_DATABASE=smart_analytics \
#     -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=<初始密码> \
#     [-e REDIS_URL=redis://... 多实例状态同步] \
#     [-e SCRYPT_PEPPER=<随机串> 密码哈希加固] \
#     smart-data-analytics
#
# 生产安全基线（与 server.ts fail-fast 一致）：未设置 JWT_SECRET 拒绝启动；
# 容器内监听 0.0.0.0（HOST 默认 127.0.0.1 仅适用于宿主机直跑）。

# ---------- 构建阶段：全量依赖 + vite build + esbuild bundle ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- 运行阶段：仅生产依赖 + 非 root 用户 + node fetch 探活 ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist

# 非 root 运行（node:22-alpine 内置 uid=1000 的 node 用户）
USER node

EXPOSE 3000
# alpine 无 curl/wget，用 node 内置 fetch 探活（30s 间隔，启动宽限 20s）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
