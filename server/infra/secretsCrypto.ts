/**
 * P0 数据源凭据加密：AES-256-GCM 落库加密，防止 DBA / 拖库直接拿到业务库密码。
 * 密文格式：`enc:v1:<iv>:<authTag>:<cipher>`（均 hex）。明文存量读取时原样返回（迁移期兼容），
 * 服务启动时由 initSchema 就地加密存量。
 * 密钥来源：DS_SECRET_KEY（优先）或 JWT_SECRET；生产环境缺失由 server 启动检查拦截（fail-fast）。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const PREFIX = 'enc:v1:';

// 惰性派生并缓存 32 字节密钥（ESM import 提升早于 dotenv.config()，须惰性读取）
let cachedKey: Buffer | null = null;
let cachedSource = '';
function key(): Buffer {
  const source = process.env.DS_SECRET_KEY || process.env.JWT_SECRET || 'dev-only-insecure-secret';
  if (!cachedKey || cachedSource !== source) {
    cachedKey = scryptSync(source, 'smart-analytics-ds-secret', 32);
    cachedSource = source;
  }
  return cachedKey;
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** 加密明文（幂等：已加密的值原样返回） */
export function encryptSecret(plain: string): string {
  if (!plain || isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

/** 解密密文；明文存量原样返回（迁移期兼容）。密钥不匹配/被篡改时抛错。 */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) return value;
  const [ivHex, tagHex, dataHex] = value.slice(PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/** 返回 password 已加密的 config 副本（幂等；无 password 时原样返回） */
export function encryptConfigPassword<T extends Record<string, any>>(config: T): T {
  if (!config || typeof config !== 'object' || !config.password) return config;
  return { ...config, password: encryptSecret(String(config.password)) };
}
