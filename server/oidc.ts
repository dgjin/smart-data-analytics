/**
 * P2-11 OIDC 统一身份认证（授权码流程 + JIT 建号）。
 * 零新依赖：discovery/authorize/token/userinfo 均走全局 fetch；
 * state 为一次性随机串存内存 Map（10 分钟 TTL）防 CSRF。
 * 未配置 OIDC_ISSUER + OIDC_CLIENT_ID 时 isOidcEnabled()=false（登录页不展示 SSO 入口）。
 *
 * 环境变量：
 * - OIDC_ISSUER        IdP 根地址（如 https://idp.example.com/realms/main）
 * - OIDC_CLIENT_ID / OIDC_CLIENT_SECRET（公共客户端可留空 secret）
 * - OIDC_REDIRECT_URI  回调地址（默认 http://localhost:{PORT}/api/auth/oidc/callback）
 * - OIDC_DEFAULT_ROLE  JIT 建号默认角色（默认 VIEWER）
 */
import { randomBytes } from 'crypto';
import { getPool } from './db';
import { hashPassword } from './passwords';
import type { AuthUser, UserRole } from './auth';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  defaultRole: UserRole;
}

export function oidcConfig(): OidcConfig | null {
  const issuer = (process.env.OIDC_ISSUER || '').trim().replace(/\/+$/, '');
  const clientId = (process.env.OIDC_CLIENT_ID || '').trim();
  if (!issuer || !clientId) return null;
  const rawRole = (process.env.OIDC_DEFAULT_ROLE || '').trim();
  const defaultRole = (['ADMIN', 'ANALYST', 'VIEWER'].includes(rawRole) ? rawRole : 'VIEWER') as UserRole;
  return {
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    redirectUri:
      (process.env.OIDC_REDIRECT_URI || '').trim() ||
      `http://localhost:${process.env.PORT || 3000}/api/auth/oidc/callback`,
    defaultRole,
  };
}

export function isOidcEnabled(): boolean {
  return oidcConfig() !== null;
}

// ---- discovery（1 小时缓存，避免每次登录都回源 IdP）----
export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
}
let endpointsCache: { issuer: string; at: number; endpoints: OidcEndpoints } | null = null;

export async function discoverEndpoints(): Promise<OidcEndpoints> {
  const cfg = oidcConfig();
  if (!cfg) throw new Error('OIDC 未配置');
  if (endpointsCache && endpointsCache.issuer === cfg.issuer && Date.now() - endpointsCache.at < 3_600_000) {
    return endpointsCache.endpoints;
  }
  const resp = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`OIDC discovery 失败（HTTP ${resp.status}）`);
  const doc: any = await resp.json();
  if (!doc?.authorization_endpoint || !doc?.token_endpoint) throw new Error('OIDC discovery 文档不完整');
  const endpoints: OidcEndpoints = {
    authorizationEndpoint: String(doc.authorization_endpoint),
    tokenEndpoint: String(doc.token_endpoint),
    userinfoEndpoint: String(doc.userinfo_endpoint || ''),
  };
  endpointsCache = { issuer: cfg.issuer, at: Date.now(), endpoints };
  return endpoints;
}

/** 测试专用：重置 discovery 缓存与 state 仓库 */
export function resetOidcStateForTest(): void {
  endpointsCache = null;
  stateStore.clear();
}

// ---- state 一次性票据（防 CSRF，10 分钟 TTL）----
const stateStore = new Map<string, number>();

export function createState(now = Date.now()): string {
  for (const [k, exp] of stateStore) {
    if (exp <= now) stateStore.delete(k);
  }
  const state = randomBytes(24).toString('base64url');
  stateStore.set(state, now + 600_000);
  return state;
}

export function consumeState(state: string, now = Date.now()): boolean {
  const exp = stateStore.get(state);
  if (!exp || exp <= now) return false;
  stateStore.delete(state); // 一次性消费
  return true;
}

export async function buildAuthorizeUrl(): Promise<string> {
  const cfg = oidcConfig();
  if (!cfg) throw new Error('OIDC 未配置');
  const ep = await discoverEndpoints();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: 'openid profile email',
    state: createState(),
  });
  return `${ep.authorizationEndpoint}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<string> {
  const cfg = oidcConfig();
  if (!cfg) throw new Error('OIDC 未配置');
  const ep = await discoverEndpoints();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
  });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  const resp = await fetch(ep.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`OIDC token 交换失败（HTTP ${resp.status}）`);
  const data: any = await resp.json();
  if (!data?.access_token) throw new Error('OIDC token 响应缺少 access_token');
  return String(data.access_token);
}

export interface OidcProfile {
  sub: string;
  username: string;
  displayName: string;
  department: string;
}

export async function fetchUserInfo(accessToken: string): Promise<OidcProfile> {
  const ep = await discoverEndpoints();
  if (!ep.userinfoEndpoint) throw new Error('OIDC 缺少 userinfo 端点');
  const resp = await fetch(ep.userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`OIDC userinfo 获取失败（HTTP ${resp.status}）`);
  const data: any = await resp.json();
  if (!data?.sub) throw new Error('OIDC userinfo 缺少 sub');
  return {
    sub: String(data.sub),
    username: String(data.preferred_username || data.email || data.sub),
    displayName: String(data.name || data.preferred_username || data.sub),
    department: String(data.department || data.dept || ''),
  };
}

/** 用户名规整：转为合法本地用户名（3-44 位小写字母数字._-），过短补 sso_ 前缀 */
export function sanitizeOidcUsername(raw: string): string {
  const base = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 44);
  return base.length >= 3 ? base : `sso_${base}`.slice(0, 44);
}

/**
 * JIT 建号/同步：按规整后的 username 命中本地账号；
 * 不存在则按 OIDC_DEFAULT_ROLE 创建（随机密码占位，该账号无法走本地密码登录）。
 * 已存在用户每次登录以 IdP 为权威源同步 displayName/department。
 */
export async function findOrCreateOidcUser(profile: OidcProfile): Promise<AuthUser> {
  const cfg = oidcConfig();
  const username = sanitizeOidcUsername(profile.username);
  const dept = (profile.department || '').slice(0, 100);
  const name = (profile.displayName || username).slice(0, 50);
  const pool = getPool();

  const [rows] = await pool.query(
    'SELECT id, username, display_name, department, role, status, must_change_password FROM users WHERE username = ? LIMIT 1',
    [username]
  );
  const existing = (rows as any[])[0];
  if (existing) {
    if (existing.status !== 'ACTIVE') throw new Error('账号已被禁用，请联系管理员');
    if (existing.display_name !== name || String(existing.department || '') !== dept) {
      await pool.query('UPDATE users SET display_name = ?, department = ? WHERE id = ?', [name, dept, existing.id]);
    }
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [existing.id]);
    return {
      id: existing.id,
      username: existing.username,
      displayName: name,
      department: dept,
      role: existing.role,
      mustChangePassword: !!existing.must_change_password,
    };
  }

  const role = cfg?.defaultRole || 'VIEWER';
  const [result] = await pool.query(
    'INSERT INTO users (username, password_hash, display_name, department, role, must_change_password) VALUES (?, ?, ?, ?, ?, 0)',
    [username, hashPassword(randomBytes(16).toString('hex')), name, dept, role]
  );
  const id = Number((result as any).insertId);
  console.log(`[OIDC] JIT 建号：${username}（${name}，部门=${dept || '未设置'}，角色=${role}）`);
  return { id, username, displayName: name, department: dept, role };
}
