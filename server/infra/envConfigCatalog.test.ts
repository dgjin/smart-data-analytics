import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENV_CONFIG_ALLOWED_KEYS,
  ENV_CONFIG_HIDDEN,
  ENV_CONFIG_SEED,
  applyEnvConfigToProcess,
  mergeableRows,
  sanitizeEnvConfigUpdates,
} from './envConfigCatalog';

/** 测试涉及的环境变量：逐条保存原值并在用例后恢复（防止污染其他测试） */
const TRACKED = ['AI_ENGINE', 'DEEPSEEK_MODEL', 'MYSQL_HOST', 'USER_QUERY_RATE_MAX', 'JWT_SECRET'];
const originals: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TRACKED) originals[k] = process.env[k];
});

afterEach(() => {
  for (const k of TRACKED) {
    if (originals[k] === undefined) delete process.env[k];
    else process.env[k] = originals[k];
  }
});

describe('env_config 标准键位目录', () => {
  it('种子键位无重复，白名单与种子一一对应', () => {
    const keys = ENV_CONFIG_SEED.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ENV_CONFIG_ALLOWED_KEYS.size).toBe(keys.length);
  });

  it('覆盖历史与新增键位（v0.5.0 基础清单 + DeepSeek/阈值/TTL）', () => {
    for (const key of ['AI_ENGINE', 'LLM_MODEL', 'OLLAMA_URL', 'QWEN_MODEL', 'JWT_SECRET']) {
      expect(ENV_CONFIG_ALLOWED_KEYS.has(key)).toBe(true);
    }
    for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_TIMEOUT_MS', 'LLM_SQL_ROUTE_MAX_TABLES', 'QUERY_CACHE_TTL_MINUTES']) {
      expect(ENV_CONFIG_ALLOWED_KEYS.has(key)).toBe(true);
    }
  });
});

describe('sanitizeEnvConfigUpdates: PUT 输入校验与过滤', () => {
  it('结构非法或空列表拒绝', () => {
    expect(sanitizeEnvConfigUpdates(undefined)).toMatchObject({ ok: false, error: 'Invalid input' });
    expect(sanitizeEnvConfigUpdates([])).toMatchObject({ ok: false, error: 'Invalid input' });
    expect(sanitizeEnvConfigUpdates([{ key: 'AI_ENGINE' }])).toMatchObject({ ok: false, error: 'Invalid input' });
    expect(sanitizeEnvConfigUpdates([{ key: 1, value: 'x' }])).toMatchObject({ ok: false, error: 'Invalid input' });
  });

  it('白名单外的键拒绝', () => {
    const res = sanitizeEnvConfigUpdates([{ key: 'EVIL_KEY', value: 'x' }]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Forbidden key: EVIL_KEY');
  });

  it('脱敏哨兵按「未修改」跳过（核心回归：全量提交不得回写 ***hidden***）', () => {
    const res = sanitizeEnvConfigUpdates([
      { key: 'AI_ENGINE', value: 'deepseek' },
      { key: 'JWT_SECRET', value: ENV_CONFIG_HIDDEN },
      { key: 'MYSQL_PASSWORD', value: ENV_CONFIG_HIDDEN },
    ]);
    expect(res.ok).toBe(true);
    expect(res.accepted).toEqual([{ key: 'AI_ENGINE', value: 'deepseek' }]);
    expect(res.skippedUnchanged).toEqual(['JWT_SECRET', 'MYSQL_PASSWORD']);
  });
});

describe('applyEnvConfigToProcess: 面板值热更合并规则', () => {
  it('非空值覆盖 process.env 并返回实际写入的 key', () => {
    process.env.AI_ENGINE = 'ollama';
    const applied = applyEnvConfigToProcess([
      { key: 'AI_ENGINE', value: 'deepseek' },
      { key: 'DEEPSEEK_MODEL', value: 'deepseek-flash' },
    ]);
    expect(applied).toEqual(['AI_ENGINE', 'DEEPSEEK_MODEL']);
    expect(process.env.AI_ENGINE).toBe('deepseek');
    expect(process.env.DEEPSEEK_MODEL).toBe('deepseek-flash');
  });

  it('空值不覆盖（语义=回退 .env.local），且与现值相同时不计入 applied', () => {
    process.env.AI_ENGINE = 'deepseek';
    const applied = applyEnvConfigToProcess([
      { key: 'AI_ENGINE', value: '' },
      { key: 'USER_QUERY_RATE_MAX', value: '100' },
      { key: 'USER_QUERY_RATE_MAX', value: '100' },
    ]);
    expect(applied).toEqual(['USER_QUERY_RATE_MAX']);
    expect(process.env.AI_ENGINE).toBe('deepseek');
    expect(process.env.USER_QUERY_RATE_MAX).toBe('100');
  });

  it('MYSQL_* 连接配置不参与热更（自举悖论）', () => {
    process.env.MYSQL_HOST = '127.0.0.1';
    const applied = applyEnvConfigToProcess([{ key: 'MYSQL_HOST', value: 'other-host' }]);
    expect(applied).toEqual([]);
    expect(process.env.MYSQL_HOST).toBe('127.0.0.1');
  });
});

describe('mergeableRows: 启动合并的行过滤', () => {
  it('空值与白名单外的行不参与合并', () => {
    const rows = mergeableRows([
      { key: 'AI_ENGINE', value: 'deepseek' },
      { key: 'JWT_EXPIRES_IN', value: '' },
      { key: 'LEGACY_UNKNOWN', value: 'x' },
      { key: 'QWEN_MODEL', value: null },
      { key: 'USER_QUERY_RATE_MAX', value: '100' },
    ]);
    expect(rows).toEqual([
      { key: 'AI_ENGINE', value: 'deepseek' },
      { key: 'USER_QUERY_RATE_MAX', value: '100' },
    ]);
  });
});

describe('端到端语义：面板值优先且重启保持（启动合并与热更同规则）', () => {
  it('启动合并把非空保存值写入 process.env（覆盖 .env.local 语义）', () => {
    process.env.AI_ENGINE = 'ollama'; // 模拟 .env.local 已加载
    const applied = applyEnvConfigToProcess(mergeableRows([{ key: 'AI_ENGINE', value: 'deepseek' }]));
    expect(applied).toEqual(['AI_ENGINE']);
    expect(process.env.AI_ENGINE).toBe('deepseek');
  });
});
