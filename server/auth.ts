/**
 * 认证与授权模块：JWT 签发/校验 + Express 鉴权中间件。
 * 中间件在验证 token 后回查 users 表，确保禁用/角色变更立即生效。
 */
import type express from 'express';
import jwt from 'jsonwebtoken';
import { getPool } from './db';

export type UserRole = 'ADMIN' | 'ANALYST' | 'VIEWER';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ESM import 提升会使模块级 process.env 读取早于 dotenv.config()，须惰性读取
const jwtSecret = () => process.env.JWT_SECRET || 'dev-only-insecure-secret';
const jwtExpiresIn = () => process.env.JWT_EXPIRES_IN || '12h';

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, jwtSecret(), {
    expiresIn: jwtExpiresIn(),
  } as jwt.SignOptions);
}

/** 校验 Bearer token 并回查用户状态，附加 req.user */
export async function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, jwtSecret()) as jwt.JwtPayload;
  } catch {
    return res.status(401).json({ error: '登录状态无效，请重新登录' });
  }

  try {
    const [rows] = await getPool().query(
      'SELECT id, username, display_name, role, status FROM users WHERE id = ? LIMIT 1',
      [payload.sub]
    );
    const user = (rows as any[])[0];
    if (!user || user.status !== 'ACTIVE') {
      return res.status(401).json({ error: '账号不存在或已被禁用' });
    }
    req.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    };
    next();
  } catch (err) {
    console.error('[Auth] user lookup failed:', err);
    return res.status(500).json({ error: '认证服务异常' });
  }
}

/** 角色守卫：requireRole('ADMIN') / requireRole('ADMIN','ANALYST') */
export function requireRole(...roles: UserRole[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: '未登录' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '没有权限执行此操作' });
    }
    next();
  };
}
