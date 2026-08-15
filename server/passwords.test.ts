import { describe, expect, it } from 'vitest';
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
