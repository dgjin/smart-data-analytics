/**
 * 单测全局准备（vitest setupFiles，每个测试文件执行前运行）。
 *
 * 本机 .env.local 会经 Vite 注入 process.env：若其中配置了 REDIS_URL，状态存储
 * （server/infra/stateStore.ts）会切到 Redis 实现，而测试进程及用例都不保证连接已就绪
 * （客户端为 enableOfflineQueue=false + maxRetriesPerRequest=1），首个命令即抛
 * "Stream isn't writeable and enableOfflineQueue options is false"，
 * 使 agent/auth 等大量用例随本机环境随机失败（单测不应依赖外部服务）。
 *
 * 因此单测统一关闭 Redis：需要 Redis 语义的用例（stateStore / health 等）
 * 在用例内自行设置 REDIS_URL 并注入桩实现。
 */
delete process.env.REDIS_URL;
