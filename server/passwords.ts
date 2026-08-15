/**
 * 密码哈希模块：Node 内置 crypto.scrypt + timingSafeEqual
 * 格式：`scrypt$N$salt$hash`（均为 hex 编码），零外部依赖。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_N = 16384;
const KEY_LEN = 64;

// 常见弱口令黑名单（小写比对）：注册/改密/重置统一拦截
const WEAK_PASSWORDS = new Set([
  'admin123', 'admin888', 'password', 'password1', 'p@ssw0rd',
  '12345678', '123456789', '1234567890', 'qwerty123', 'abc12345',
  '11111111', '88888888', '66668888', 'letmein123', 'welcome123',
]);

export interface PasswordStrengthResult {
  ok: boolean;
  error?: string;
}

/**
 * P0-1 密码强度校验：建用户 / 修改密码 / 管理员重置三处统一入口。
 * 规则：8-64 位；同时包含字母与数字；排除常见弱口令与包含用户名的口令。
 */
export function validatePasswordStrength(pwd: string, username?: string): PasswordStrengthResult {
  if (typeof pwd !== 'string' || pwd.length < 8 || pwd.length > 64) {
    return { ok: false, error: '密码长度需为 8-64 位' };
  }
  if (!/[A-Za-z]/.test(pwd) || !/[0-9]/.test(pwd)) {
    return { ok: false, error: '密码需同时包含字母和数字' };
  }
  if (WEAK_PASSWORDS.has(pwd.toLowerCase())) {
    return { ok: false, error: '密码为常见弱口令，请更换为更复杂的组合' };
  }
  if (username && pwd.toLowerCase().includes(username.toLowerCase())) {
    return { ok: false, error: '密码不能包含用户名' };
  }
  return { ok: true };
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  const actual = scryptSync(plain, salt, expected.length, { N: n });
  return timingSafeEqual(actual, expected);
}
