import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDlpEnabled, isDlpExempt, maskQueryPayload, maskRows } from './dlp';

const ADMIN = { role: 'ADMIN' as const };
const ANALYST = { role: 'ANALYST' as const };
const VIEWER = { role: 'VIEWER' as const };

describe('P2-12 DLP 数据脱敏', () => {
  beforeEach(() => {
    delete process.env.DLP_ENABLED;
    delete process.env.DLP_EXEMPT_ADMIN;
  });
  afterEach(() => {
    delete process.env.DLP_ENABLED;
    delete process.env.DLP_EXEMPT_ADMIN;
  });

  describe('开关与豁免', () => {
    it('默认启用，DLP_ENABLED=0 关闭', () => {
      expect(isDlpEnabled()).toBe(true);
      process.env.DLP_ENABLED = '0';
      expect(isDlpEnabled()).toBe(false);
    });

    it('默认 ADMIN 豁免，DLP_EXEMPT_ADMIN=0 取消豁免', () => {
      expect(isDlpExempt(ADMIN)).toBe(true);
      expect(isDlpExempt(ANALYST)).toBe(false);
      expect(isDlpExempt(VIEWER)).toBe(false);
      process.env.DLP_EXEMPT_ADMIN = '0';
      expect(isDlpExempt(ADMIN)).toBe(false);
    });

    it('全局关闭时所有角色不脱敏', () => {
      process.env.DLP_ENABLED = '0';
      const rows = [{ mobile: '13812345678' }];
      const out = maskRows(rows, VIEWER);
      expect(out.rows[0].mobile).toBe('13812345678');
      expect(out.maskedColumns).toEqual([]);
    });
  });

  describe('列名命中', () => {
    it('phone/mobile 列名命中手机号规则', () => {
      const rows = [{ name: '张三', mobile: '13812345678' }];
      const out = maskRows(rows, VIEWER);
      expect(out.rows[0].mobile).toBe('138****5678');
      expect(out.rows[0].name).toBe('张三');
      expect(out.maskedColumns).toEqual(['mobile']);
      expect(out.maskedLabels).toEqual(['手机号']);
    });

    it('id_card 列名命中身份证规则', () => {
      const rows = [{ id_card: '11010119900307771X' }];
      const out = maskRows(rows, ANALYST);
      expect(out.rows[0].id_card).toBe('1101**********771X');
      expect(out.maskedLabels).toEqual(['身份证']);
    });

    it('email 列名命中邮箱规则', () => {
      const rows = [{ email: 'zhangsan@example.com' }];
      const out = maskRows(rows, VIEWER);
      expect(out.rows[0].email).toBe('z***@example.com');
    });

    it('card_no 列名命中银行卡规则', () => {
      const rows = [{ card_no: '6222020200112233445' }];
      const out = maskRows(rows, VIEWER);
      expect(out.rows[0].card_no).toBe('***************3445');
    });
  });

  describe('内容抽样命中（列名不含关键词）', () => {
    it('内容命中手机号', () => {
      const rows = [{ contact: '13812345678' }, { contact: '13998765432' }];
      const out = maskRows(rows, VIEWER);
      expect(out.rows[0].contact).toBe('138****5678');
      expect(out.rows[1].contact).toBe('139****5432');
      expect(out.maskedColumns).toEqual(['contact']);
    });

    it('内容命中身份证（含 X）', () => {
      const rows = [{ cert: '11010119900307771X' }];
      const out = maskRows(rows, ANALYST);
      expect(out.rows[0].cert).toBe('1101**********771X');
    });

    it('普通业务数值不误伤（金额/年份）', () => {
      const rows = [
        { amount: 123456, year: 2026, ratio: 0.95 },
        { amount: 789012, year: 2025, ratio: 1.02 },
      ];
      const out = maskRows(rows, VIEWER);
      expect(out.maskedColumns).toEqual([]);
      expect(out.rows).toEqual(rows);
    });

    it('短字符串不触发内容匹配', () => {
      const rows = [{ code: 'A01' }, { code: 'B02' }];
      const out = maskRows(rows, VIEWER);
      expect(out.maskedColumns).toEqual([]);
    });
  });

  describe('行为约束', () => {
    it('ADMIN 豁免时原样返回', () => {
      const rows = [{ mobile: '13812345678' }];
      const out = maskRows(rows, ADMIN);
      expect(out.rows[0].mobile).toBe('13812345678');
      expect(out.maskedColumns).toEqual([]);
    });

    it('不原地修改入参（防缓存污染）', () => {
      const rows = [{ mobile: '13812345678' }];
      const snapshot = JSON.parse(JSON.stringify(rows));
      maskRows(rows, VIEWER);
      expect(rows).toEqual(snapshot);
    });

    it('空数组与 null 值安全', () => {
      expect(maskRows([], VIEWER).maskedColumns).toEqual([]);
      const out = maskRows([{ mobile: null }, { mobile: '' }] as any, VIEWER);
      expect(out.rows[0].mobile).toBeNull();
      expect(out.rows[1].mobile).toBe('');
    });

    it('多列混合：命中列脱敏，其余列保留', () => {
      const rows = [{ dept: '风险部', mobile: '13812345678', amount: 5000, mail: 'a@b.com' }];
      const out = maskRows(rows, VIEWER);
      expect(out.rows[0].dept).toBe('风险部');
      expect(out.rows[0].mobile).toBe('138****5678');
      expect(out.rows[0].amount).toBe(5000);
      expect(out.rows[0].mail).toBe('a***@b.com');
      expect(out.maskedColumns.sort()).toEqual(['mail', 'mobile']);
    });
  });

  describe('maskQueryPayload（问数结果整体）', () => {
    it('脱敏 result.rows 并附 dlp 标记，原 payload 不被修改', () => {
      const payload = {
        success: true,
        result: { rows: [{ mobile: '13812345678' }], chartConfig: { type: 'table' } },
      };
      const out = maskQueryPayload(payload as any, VIEWER);
      expect(out.result!.rows![0].mobile).toBe('138****5678');
      expect(out.dlp?.maskedLabels).toEqual(['手机号']);
      // 原 payload 保持原始数据（缓存安全）
      expect(payload.result.rows[0].mobile).toBe('13812345678');
      expect((payload as any).dlp).toBeUndefined();
    });

    it('ADMIN 豁免时原样返回同一引用', () => {
      const payload = { result: { rows: [{ mobile: '13812345678' }] } };
      const out = maskQueryPayload(payload as any, ADMIN);
      expect(out).toBe(payload);
    });

    it('无敏感数据时原样返回', () => {
      const payload = { result: { rows: [{ dept: '风险部' }] } };
      const out = maskQueryPayload(payload as any, VIEWER);
      expect(out).toBe(payload);
      expect((out as any).dlp).toBeUndefined();
    });
  });
});
