/**
 * P2-12 DLP 数据防泄漏：查询结果敏感字段自动脱敏。
 *
 * 识别方式（双通道）：
 * 1. 列名命中：phone/mobile/idcard/sfz/cardno/email 等关键词直接判定该列敏感
 * 2. 内容抽样：对未命中列抽样前 N 行做正则匹配（手机号/身份证/银行卡/邮箱），命中即按规则掩码
 *
 * 掩码策略：保留可辨识首尾（如 138****5678、1101**********1234），兼顾排查可用性与隐私。
 * 角色策略：默认 ADMIN 豁免（DLP_EXEMPT_ADMIN=0 可关闭豁免）；DLP_ENABLED=0 全局关闭。
 *
 * 关键约束：返回拷贝、绝不原地修改入参——问数结果对象会先写入缓存（原始数据），
 * 若原地脱敏会污染缓存，导致后续 ADMIN 命中缓存拿到脱敏数据。
 */
import type { AuthUser } from './auth';

export interface DlpRule {
  key: string;
  label: string;
  /** 列名匹配（命中即整列脱敏） */
  columnPattern: RegExp;
  /** 内容匹配（抽样命中即对该列脱敏） */
  valuePattern: RegExp;
  mask: (v: string) => string;
}

/** 内置敏感数据规则（手机号/身份证/银行卡/邮箱） */
export const DLP_RULES: DlpRule[] = [
  {
    key: 'phone',
    label: '手机号',
    columnPattern: /phone|mobile|tel(?:ephone)?|sjh|shouji/i,
    valuePattern: /(?<!\d)1[3-9]\d{9}(?!\d)/,
    mask: (v) => (v.length >= 7 ? `${v.slice(0, 3)}****${v.slice(-4)}` : '****'),
  },
  {
    key: 'idcard',
    label: '身份证',
    columnPattern: /id_?card|sfz|shenfenzheng|identity/i,
    valuePattern: /(?<![0-9A-Za-z])\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![0-9A-Za-z])/,
    mask: (v) => (v.length >= 8 ? `${v.slice(0, 4)}${'*'.repeat(v.length - 8)}${v.slice(-4)}` : '****'),
  },
  {
    key: 'bankcard',
    label: '银行卡号',
    columnPattern: /bank_?card|card_?no|cardno|kahao|acct_?no/i,
    valuePattern: /(?<!\d)\d{16,19}(?!\d)/,
    mask: (v) => (v.length >= 8 ? `${'*'.repeat(v.length - 4)}${v.slice(-4)}` : '****'),
  },
  {
    key: 'email',
    label: '邮箱',
    columnPattern: /e?_?mail|youxiang/i,
    valuePattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    mask: (v) => {
      const at = v.indexOf('@');
      if (at <= 0) return '***';
      return `${v.slice(0, 1)}***${v.slice(at)}`;
    },
  },
];

/** 内容抽样行数上限（大结果集不全量扫，控制 CPU） */
const SAMPLE_ROWS = 50;

export function isDlpEnabled(): boolean {
  return process.env.DLP_ENABLED !== '0';
}

/** ADMIN 默认豁免脱敏（审计岗需看全量）；DLP_EXEMPT_ADMIN=0 关闭豁免 */
export function isDlpExempt(user: Pick<AuthUser, 'role'>): boolean {
  return user.role === 'ADMIN' && process.env.DLP_EXEMPT_ADMIN !== '0';
}

function ruleForColumn(colName: string): DlpRule | null {
  for (const rule of DLP_RULES) {
    if (rule.columnPattern.test(colName)) return rule;
  }
  return null;
}

function ruleForValue(value: unknown): DlpRule | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  if (s.length < 5) return null;
  for (const rule of DLP_RULES) {
    if (rule.valuePattern.test(s)) return rule;
  }
  return null;
}

export interface MaskedRows {
  rows: Record<string, any>[];
  /** 被脱敏的列名（供 UI 提示「已脱敏」与审计） */
  maskedColumns: string[];
  /** 命中的规则标签（如 ['手机号','身份证']，供审计/提示） */
  maskedLabels: string[];
}

/**
 * 对查询结果行集按角色策略脱敏。返回新数组（原数组与行对象不被修改）。
 * ADMIN（豁免开启时）/全局关闭/空集 直接原样返回。
 */
export function maskRows(rows: Record<string, any>[], user: Pick<AuthUser, 'role'>): MaskedRows {
  if (!isDlpEnabled() || isDlpExempt(user) || !Array.isArray(rows) || rows.length === 0) {
    return { rows, maskedColumns: [], maskedLabels: [] };
  }

  const columns = Object.keys(rows[0] || {});
  // 列规则映射：列名命中优先；否则抽样内容判定
  const colRule = new Map<string, DlpRule>();
  const sample = rows.slice(0, SAMPLE_ROWS);
  for (const col of columns) {
    const named = ruleForColumn(col);
    if (named) {
      colRule.set(col, named);
      continue;
    }
    for (const row of sample) {
      const hit = ruleForValue(row[col]);
      if (hit) {
        colRule.set(col, hit);
        break;
      }
    }
  }

  if (colRule.size === 0) return { rows, maskedColumns: [], maskedLabels: [] };

  const masked = rows.map((row) => {
    const next: Record<string, any> = { ...row };
    for (const [col, rule] of colRule) {
      const v = next[col];
      if (v === null || v === undefined || v === '') continue;
      next[col] = rule.mask(String(v));
    }
    return next;
  });

  const maskedColumns = [...colRule.keys()];
  const maskedLabels = [...new Set([...colRule.values()].map((r) => r.label))];
  return { rows: masked, maskedColumns, maskedLabels };
}

/**
 * 问数结果 payload 脱敏：处理 payload.result.rows（存在时），返回新 payload
 * （result 对象同样拷贝，避免污染缓存中的原始引用），并附加 dlp 标记供前端提示。
 */
export function maskQueryPayload<T extends { result?: { rows?: Record<string, any>[] } }>(
  payload: T,
  user: Pick<AuthUser, 'role'>,
): T & { dlp?: { maskedColumns: string[]; maskedLabels: string[] } } {
  const rows = payload?.result?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return payload;
  const { rows: masked, maskedColumns, maskedLabels } = maskRows(rows, user);
  if (maskedColumns.length === 0) return payload;
  return {
    ...payload,
    result: { ...payload.result!, rows: masked },
    dlp: { maskedColumns, maskedLabels },
  };
}
