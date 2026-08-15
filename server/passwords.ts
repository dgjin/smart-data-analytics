/**
 * 密码哈希模块：Node 内置 crypto.scrypt + timingSafeEqual，零外部依赖。
 * P2-8 显式提参（N=2^15, r=8, p=1）+ pepper（SCRYPT_PEPPER 环境变量）。
 * 新格式：`scrypt$N$r$p$P$salt$hash`（P=1 表示哈希时拼接了 pepper）；
 * 旧格式：`scrypt$N$salt$hash`（4 段，隐含 r=8/p=1/无 pepper）继续兼容校验。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_N = 32768; // 2^15：单次哈希约 80ms，暴力破解成本翻倍
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
// 128*N*r=32MB 恰好撞上 Node 默认 maxmem（33554432），显式放宽到 64MB
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;
/** 服务级密钥（pepper）：与库表分离存储，拖库后离线爆破仍需 env 配合；未配置则不启用（向后兼容） */
const SCRYPT_PEPPER = process.env.SCRYPT_PEPPER || '';

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
  const usedPepper = SCRYPT_PEPPER ? 1 : 0;
  const material = usedPepper ? plain + SCRYPT_PEPPER : plain;
  const hash = scryptSync(material, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${usedPepper}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return false;

  // 旧 4 段格式：scrypt$N$salt$hash（隐含 r=8/p=1，未用 pepper）
  if (parts.length === 4) {
    const n = Number(parts[1]);
    if (!Number.isFinite(n) || n <= 0) return false;
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    try {
      const actual = scryptSync(plain, salt, expected.length, { N: n, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  // 新 7 段格式：scrypt$N$r$p$P$salt$hash
  if (parts.length === 7) {
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const usedPepper = parts[4] === '1';
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(r) || r <= 0 || !Number.isFinite(p) || p <= 0) return false;
    const salt = Buffer.from(parts[5], 'hex');
    const expected = Buffer.from(parts[6], 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    // 哈希时带 pepper 但当前环境未配置：fail-closed（无法还原材料，直接拒绝）
    if (usedPepper && !SCRYPT_PEPPER) return false;
    const material = usedPepper ? plain + SCRYPT_PEPPER : plain;
    try {
      const actual = scryptSync(material, salt, expected.length, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  return false;
}
