import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptConfigPassword, encryptSecret, isEncrypted } from './secretsCrypto';

describe('secretsCrypto', () => {
  it('加密后可解密还原（round-trip）', () => {
    const cipher = encryptSecret('MyP@ssw0rd!');
    expect(isEncrypted(cipher)).toBe(true);
    expect(cipher).not.toContain('MyP@ssw0rd!');
    expect(decryptSecret(cipher)).toBe('MyP@ssw0rd!');
  });

  it('同一明文每次加密产生不同密文（随机 IV）', () => {
    expect(encryptSecret('abc')).not.toBe(encryptSecret('abc'));
  });

  it('加密幂等：已加密的值不会二次加密', () => {
    const once = encryptSecret('secret');
    expect(encryptSecret(once)).toBe(once);
  });

  it('明文存量透传（迁移期兼容）', () => {
    expect(decryptSecret('plain-password')).toBe('plain-password');
    expect(decryptSecret('')).toBe('');
  });

  it('密文被篡改时解密抛错（GCM 认证）', () => {
    const cipher = encryptSecret('secret');
    const tampered = cipher.slice(0, -2) + (cipher.endsWith('00') ? '11' : '00');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('encryptConfigPassword 只加密 password 字段且不改原对象', () => {
    const config = { host: 'localhost', username: 'ro_user', password: 'pw' };
    const out = encryptConfigPassword(config);
    expect(out.host).toBe('localhost');
    expect(isEncrypted(out.password)).toBe(true);
    expect(config.password).toBe('pw');
  });

  it('encryptConfigPassword 无 password 时原样返回', () => {
    const config = { host: 'localhost' } as any;
    expect(encryptConfigPassword(config)).toBe(config);
  });
});
