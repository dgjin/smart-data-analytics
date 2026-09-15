/**
 * 路由层契约测试基座（质量优化 Stage 2）：统一 Express 装配 / JWT 令牌签发 / DB 查询桩。
 * 文件名不匹配 vitest 测试 glob（非 *.test.ts），仅供各路由测试文件导入，不会被当作用例执行。
 */
import http from 'node:http';
import express, { Router } from 'express';
import { signToken, AuthUser, UserRole } from '../auth/auth';

// Node ≥19 的 globalAgent 默认开启 keep-alive。本基座已改为复用长驻 server（见 buildApp），
// 仍显式禁用连接复用，为残留的临时 server 路径（如用例内自行 express() 的场景）兜底。
// （@types/node 的 http.Agent 基类未声明 keepAlive，Node ≥19 运行时支持，此处局部类型补充）
(http.globalAgent as http.Agent & { keepAlive: boolean }).keepAlive = false;

/** 测试环境变量：JWT 密钥与限流阈值均惰性读取，导入被测路由前后调用皆可 */
export function applyTestEnv() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
  // 契约测试共享内存限流计数器（默认 30/min 会误伤多断言用例）
  process.env.RATE_LIMIT_MAX = '100000';
}

/** 签发指定角色的访问令牌（与生产同源 signToken，鉴权链路真实生效） */
export function tokenFor(role: UserRole = 'ADMIN', id = 1): string {
  const user: AuthUser = {
    id,
    username: `u${id}`,
    displayName: `用户${id}`,
    department: '测试部',
    role,
    mustChangePassword: false,
  };
  return signToken(user);
}

/** authMiddleware 回查用户状态所需行（ACTIVE；与 users 表 SELECT 列对齐） */
export function activeUserRow(role: UserRole = 'ADMIN', id = 1) {
  return {
    id,
    username: `u${id}`,
    display_name: `用户${id}`,
    department: '测试部',
    role,
    status: 'ACTIVE',
    must_change_password: 0,
  };
}

export interface DbStubRule {
  /** SQL 片段或正则（命中即返回该结果） */
  match: string | RegExp;
  /** 返回行集（或惰性函数，避免用例间共享可变对象） */
  rows: unknown[] | (() => unknown[]);
}

/**
 * 按 SQL 分派 getPool().query 的桩实现。
 * 未命中规则直接抛错（而非静默返回空集），避免用例因桩缺配而"假通过"。
 */
export function dbStub(rules: DbStubRule[]) {
  return async (sql: string, _params?: unknown[]) => {
    for (const rule of rules) {
      const hit = typeof rule.match === 'string' ? sql.includes(rule.match) : rule.match.test(sql);
      if (hit) {
        const rows = typeof rule.rows === 'function' ? (rule.rows as () => unknown[])() : rule.rows;
        return [rows];
      }
    }
    throw new Error(`[routeTestKit] 未匹配的 SQL: ${String(sql).slice(0, 160)}`);
  };
}

/**
 * 装配被测路由（express.json 与生产一致；路由自带 authMiddleware 链），返回已监听的 server。
 * 关键：返回 listening server 而非裸 app——supertest 检测到 address() 已存在时会直接复用该 server，
 * 不再为每次请求创建/销毁临时监听端口（高频 ephemeral 端口 listen/close 在 Node 22 下会造成
 * 偶发 "Parse Error: Expected HTTP/, RTSP/ or ICE/" 抖动；长驻 server 从机制上消除该竞态）。
 */
export function buildApp(mountPath: string, router: Router) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(mountPath, router);
  return app.listen(0);
}
