/**
 * 前端密码强度 / 用户名格式校验单测（与 server/auth/passwords.ts 同规则，改动须双端同步）。
 */
import { describe, expect, it } from 'vitest';
import { USERNAME_PATTERN, checkPasswordStrength } from './passwordStrength';

describe('USERNAME_PATTERN', () => {
  it('接受 3-20 位字母 / 数字 / 下划线', () => {
    expect(USERNAME_PATTERN.test('abc')).toBe(true);
    expect(USERNAME_PATTERN.test('zhang_san1')).toBe(true);
    expect(USERNAME_PATTERN.test('A'.repeat(20))).toBe(true);
  });

  it('拒绝中文、连字符、点号、空格、过短或过长', () => {
    expect(USERNAME_PATTERN.test('张三')).toBe(false);
    expect(USERNAME_PATTERN.test('zhang-san')).toBe(false);
    expect(USERNAME_PATTERN.test('zhang.san')).toBe(false);
    expect(USERNAME_PATTERN.test('zhang san')).toBe(false);
    expect(USERNAME_PATTERN.test('ab')).toBe(false);
    expect(USERNAME_PATTERN.test('a'.repeat(21))).toBe(false);
  });
});

describe('checkPasswordStrength', () => {
  it('通过：8-64 位且同时包含字母和数字', () => {
    expect(checkPasswordStrength('Abcd1234')).toEqual({ ok: true });
    expect(checkPasswordStrength(`a1${'X'.repeat(62)}`)).toEqual({ ok: true });
  });

  it('长度不足 8 位或超过 64 位被拒', () => {
    expect(checkPasswordStrength('Abc123').error).toContain('8-64');
    expect(checkPasswordStrength(`a1${'X'.repeat(63)}`).error).toContain('8-64');
  });

  it('仅字母或仅数字被拒', () => {
    expect(checkPasswordStrength('abcdefgh').error).toBe('密码需同时包含字母和数字');
    expect(checkPasswordStrength('12345678').error).toBe('密码需同时包含字母和数字');
  });

  it('常见弱口令被拒（含字母数字的组合）', () => {
    expect(checkPasswordStrength('admin123').error).toContain('弱口令');
    expect(checkPasswordStrength('Password1').error).toContain('弱口令');
  });

  it('包含用户名被拒（不区分大小写）', () => {
    expect(checkPasswordStrength('zhangsan123', 'zhangsan').error).toBe('密码不能包含用户名');
    expect(checkPasswordStrength('Zhangsan123', 'zhangsan').error).toBe('密码不能包含用户名');
  });

  it('未传用户名时跳过包含性检查', () => {
    expect(checkPasswordStrength('zhangsan123').ok).toBe(true);
  });
});
