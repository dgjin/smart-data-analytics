import { describe, expect, it } from 'vitest';
import { randomBytes, scryptSync } from 'crypto';
import { hashPassword, validatePasswordStrength, verifyPassword } from './passwords';

describe('validatePasswordStrength: P0-1 密码强度校验', () => {
  it('长度不足 8 位或超过 64 位拒绝', () => {
    expect(validatePasswordStrength('ab12cd').ok).toBe(false);
    expect(validatePasswordStrength('a'.repeat(65) + '1').ok).toBe(false);
  });
  it('纯字母或纯数字拒绝（需字母+数字混合）', () => {
    expect(validatePasswordStrength('abcdefgh').ok).toBe(false);
    expect(validatePasswordStrength('12345678').ok).toBe(false);
  });
  it('常见弱口令拒绝', () => {
    expect(validatePasswordStrength('admin123').ok).toBe(false);
    expect(validatePasswordStrength('Password1').ok).toBe(false);
    expect(validatePasswordStrength('123456789').ok).toBe(false);
  });
  it('包含用户名拒绝', () => {
    expect(validatePasswordStrength('admin2026xyz', 'admin').ok).toBe(false);
    expect(validatePasswordStrength('Admin2026!@', 'admin').ok).toBe(false);
  });
  it('合法强口令通过', () => {
    expect(validatePasswordStrength('Xk9mQ2vL').ok).toBe(true);
    expect(validatePasswordStrength('tsmc2026lts', 'dgjin').ok).toBe(true);
  });
  it('非字符串输入安全拒绝', () => {
    expect(validatePasswordStrength(undefined as any).ok).toBe(false);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('哈希可验证且每次加盐不同', () => {
    const a = hashPassword('Str0ngPass');
    const b = hashPassword('Str0ngPass');
    expect(a).not.toBe(b);
    expect(verifyPassword('Str0ngPass', a)).toBe(true);
    expect(verifyPassword('wrong', a)).toBe(false);
  });
  it('格式损坏时验证失败而非抛错', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('P2-8 显式提参（N=2^15, r=8, p=1）+ 新旧格式兼容', () => {
  it('新哈希为 7 段格式且参数显式记录', () => {
    const h = hashPassword('Str0ngPass');
    const parts = h.split('$');
    expect(parts).toHaveLength(7);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBe(32768);
    expect(Number(parts[2])).toBe(8);
    expect(Number(parts[3])).toBe(1);
    expect(['0', '1']).toContain(parts[4]);
  });
  it('旧 4 段格式（N=16384）仍可验证登录', () => {
    // 用旧参数手工构造：scrypt$16384$salt$hash（隐含 r=8/p=1/无 pepper）
    const salt = randomBytes(16);
    const hash = scryptSync('legacyPass9', salt, 64, { N: 16384, r: 8, p: 1 });
    const stored = `scrypt$16384$${salt.toString('hex')}$${hash.toString('hex')}`;
    expect(stored.split('$')).toHaveLength(4);
    expect(verifyPassword('legacyPass9', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });
  it('参数/盐/哈希段非法时 fail-closed', () => {
    expect(verifyPassword('x', 'scrypt$0$8$1$0$abcd$ef00')).toBe(false);
    expect(verifyPassword('x', 'scrypt$32768$8$1$0$$')).toBe(false);
    expect(verifyPassword('x', 'scrypt$32768$8$1$0$abcd$')).toBe(false);
    expect(verifyPassword('x', 'scrypt$abc$8$1$0$abcd$ef00')).toBe(false);
    expect(verifyPassword('x', 'scrypt$32768$8$1$0$abcd$zz')).toBe(false);
  });
});
