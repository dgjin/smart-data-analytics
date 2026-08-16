import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// mock 数据库：外部源配置链路只验证 SQL 参数与加密行为，不连真实 MySQL
const querySpy = vi.fn(async (..._args: any[]): Promise<any> => [[], []]);
vi.mock('./db', () => ({ getPool: () => ({ query: (...args: any[]) => querySpy(...args) }) }));

import {
  parseExternalKbResponse,
  validateExternalKbInput,
  callExternalKb,
  searchExternalKnowledge,
  listExternalKbSources,
  saveExternalKbSource,
  setExternalKbFetch,
} from './externalKnowledge';
import { encryptSecret, decryptSecret } from './secretsCrypto';

describe('parseExternalKbResponse: 外部检索响应容错解析', () => {
  it('兼容 results / documents / data / items 四种容器字段', () => {
    expect(parseExternalKbResponse({ results: [{ content: 'A' }] })[0].text).toBe('A');
    expect(parseExternalKbResponse({ documents: [{ text: 'B' }] })[0].text).toBe('B');
    expect(parseExternalKbResponse({ data: [{ chunk: 'C' }] })[0].text).toBe('C');
    expect(parseExternalKbResponse({ items: [{ pageContent: 'D' }] })[0].text).toBe('D');
  });

  it('顶层数组与字符串数组直接解析', () => {
    expect(parseExternalKbResponse([{ content: 'X' }, '纯字符串项'])[0].text).toBe('X');
    expect(parseExternalKbResponse(['纯字符串项'])).toHaveLength(1);
  });

  it('source/title 字段作为来源标注', () => {
    const r = parseExternalKbResponse({ results: [{ content: 'A', title: '口径手册' }] });
    expect(r[0].source).toBe('口径手册');
  });

  it('无命中 / 非数组 / 空对象返回空数组不抛错', () => {
    expect(parseExternalKbResponse(null)).toEqual([]);
    expect(parseExternalKbResponse({ foo: 1 })).toEqual([]);
    expect(parseExternalKbResponse({ results: 'not-array' })).toEqual([]);
    expect(parseExternalKbResponse([{ score: 1 }])).toEqual([]);
  });

  it('单片段超 600 字截断防外部服务返回整本书', () => {
    const r = parseExternalKbResponse({ results: [{ content: '长'.repeat(1000) }] });
    expect(r[0].text.length).toBe(600);
  });

  it('最多取 20 个片段', () => {
    const r = parseExternalKbResponse({ results: Array.from({ length: 30 }, (_, i) => ({ content: `k${i}` })) });
    expect(r).toHaveLength(20);
  });
});

describe('validateExternalKbInput: 配置校验', () => {
  const base = { name: '集团知识平台', endpoint: 'http://kb.internal/api/search', authType: 'none', timeoutMs: 5000 };

  it('合法配置通过', () => {
    expect(validateExternalKbInput(base)).toBeNull();
  });

  it('缺名称 / 非 http(s) 地址 / 超时越界分别拦截', () => {
    expect(validateExternalKbInput({ ...base, name: ' ' })).toContain('名称');
    expect(validateExternalKbInput({ ...base, endpoint: 'ftp://x' })).toContain('http(s)');
    expect(validateExternalKbInput({ ...base, timeoutMs: 100 })).toContain('超时');
    expect(validateExternalKbInput({ ...base, timeoutMs: 99999 })).toContain('超时');
  });

  it('bearer 认证必须携带 API Key', () => {
    expect(validateExternalKbInput({ ...base, authType: 'bearer', apiKey: '' })).toContain('API Key');
    expect(validateExternalKbInput({ ...base, authType: 'bearer', apiKey: 'sk-xxx' })).toBeNull();
  });
});

describe('callExternalKb: 单源检索调用', () => {
  afterEach(() => setExternalKbFetch(null));

  it('POST JSON 请求体 { query, topK }，bearer 时携带 Authorization 头', async () => {
    let captured: any = null;
    setExternalKbFetch(async (url: any, init: any) => {
      captured = { url, init };
      return new Response(JSON.stringify({ results: [{ content: '片段' }] }), { status: 200 });
    });
    const chunks = await callExternalKb(
      { endpoint: 'http://kb/api/search', authType: 'bearer', apiKey: 'sk-1', timeoutMs: 3000 },
      '什么是不良率',
      4
    );
    expect(chunks[0].text).toBe('片段');
    expect(captured.init.method).toBe('POST');
    expect(JSON.parse(captured.init.body)).toEqual({ query: '什么是不良率', topK: 4 });
    expect(captured.init.headers['Authorization']).toBe('Bearer sk-1');
    expect(captured.init.headers['Content-Type']).toBe('application/json');
  });

  it('无认证时不携带 Authorization 头', async () => {
    let captured: any = null;
    setExternalKbFetch(async (_url: any, init: any) => {
      captured = init;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    await callExternalKb({ endpoint: 'http://kb/api/search', authType: 'none', apiKey: undefined, timeoutMs: 3000 }, 'q');
    expect(captured.headers['Authorization']).toBeUndefined();
  });

  it('非 2xx 响应抛错（调用方降级）', async () => {
    setExternalKbFetch(async () => new Response('nope', { status: 502 }));
    await expect(
      callExternalKb({ endpoint: 'http://kb/api/search', authType: 'none', apiKey: undefined, timeoutMs: 3000 }, 'q')
    ).rejects.toThrow('HTTP 502');
  });

  it('超时中断：timeoutMs 到期 abort 未完成的请求', async () => {
    setExternalKbFetch(
      (_url: any, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    await expect(
      callExternalKb({ endpoint: 'http://kb/api/search', authType: 'none', apiKey: undefined, timeoutMs: 500 }, 'q')
    ).rejects.toThrow();
  });
});

describe('searchExternalKnowledge: 问数链路聚合检索', () => {
  beforeEach(() => { querySpy.mockReset(); });
  afterEach(() => setExternalKbFetch(null));

  const rowsOf = (rows: any[]) => querySpy.mockResolvedValue([rows, []]);

  it('并行检索全部适用源并按「外部·源名」前缀格式化', async () => {
    // mock 模拟 SQL WHERE 过滤（enabled=1 且 data_source_id 匹配具体 ds 或 '*'）
    const allRows = [
      { id: 'ekb_1', name: '集团平台', endpoint: 'http://a/search', auth_type: 'none', enabled: 1, timeout_ms: 3000, data_source_id: '*', created_by: 'admin' },
      { id: 'ekb_2', name: '行内知识', endpoint: 'http://b/search', auth_type: 'none', enabled: 1, timeout_ms: 3000, data_source_id: 'ds1', created_by: 'admin' },
      { id: 'ekb_3', name: '其他数据源专用', endpoint: 'http://c/search', auth_type: 'none', enabled: 1, timeout_ms: 3000, data_source_id: 'ds2', created_by: 'admin' },
      { id: 'ekb_4', name: '已停用', endpoint: 'http://d/search', auth_type: 'none', enabled: 0, timeout_ms: 3000, data_source_id: '*', created_by: 'admin' },
    ];
    querySpy.mockImplementation(async (sql: any, params: any) => {
      if (String(sql).includes('FROM external_kb_sources WHERE enabled')) {
        const [ds, wildcard] = params as string[];
        return [allRows.filter((r) => Number(r.enabled) === 1 && (r.data_source_id === ds || r.data_source_id === wildcard)), []];
      }
      return [[], []];
    });
    setExternalKbFetch(async (url: any) =>
      new Response(JSON.stringify({ results: [{ content: `来自${url}的口径片段` }] }), { status: 200 })
    );
    const r = await searchExternalKnowledge('ds1', '不良率口径');
    // SQL 过滤条件含具体 ds 与通配 '*'
    const sql = querySpy.mock.calls[0][0] as string;
    expect(sql).toContain('enabled = 1');
    expect(sql).toContain("data_source_id = ? OR data_source_id = ?");
    // 命中 2 个适用源（ds1 专用 + 全局），停用源与其他数据源专用源不参与
    expect(r.okSources).toBe(2);
    expect(r.failSources).toBe(0);
    expect(r.snippet).toContain('外部知识库片段');
    expect(r.snippet).toContain('- [外部·集团平台] 来自http://a/search的口径片段');
    expect(r.snippet).toContain('- [外部·行内知识] 来自http://b/search的口径片段');
  });

  it('单源失败降级为空且不阻断其他源', async () => {
    rowsOf([
      { id: 'ekb_1', name: '好源', endpoint: 'http://a/search', auth_type: 'none', enabled: 1, timeout_ms: 3000, data_source_id: '*', created_by: 'admin' },
      { id: 'ekb_2', name: '坏源', endpoint: 'http://b/search', auth_type: 'none', enabled: 1, timeout_ms: 3000, data_source_id: '*', created_by: 'admin' },
    ]);
    setExternalKbFetch(async (url: any) => {
      if (String(url).includes('b/')) return new Response('down', { status: 500 });
      return new Response(JSON.stringify({ results: [{ content: 'A' }] }), { status: 200 });
    });
    const r = await searchExternalKnowledge('ds1', 'q');
    expect(r.okSources).toBe(1);
    expect(r.failSources).toBe(1);
    expect(r.snippet).toContain('- [外部·好源] A');
  });

  it('无适用源返回空结果', async () => {
    rowsOf([]);
    const r = await searchExternalKnowledge('ds1', 'q');
    expect(r.snippet).toBe('');
    expect(r.okSources).toBe(0);
  });

  it('数据库异常整体降级为空（不阻断问数主链路）', async () => {
    querySpy.mockImplementation(async () => {
      throw new Error('db down');
    });
    const r = await searchExternalKnowledge('ds1', 'q');
    expect(r.snippet).toBe('');
    expect(r.okSources).toBe(0);
  });

  it('api_key 密文在调用前解密', async () => {
    const plain = 'sk-secret-123';
    rowsOf([
      { id: 'ekb_1', name: '带认证', endpoint: 'http://a/search', auth_type: 'bearer', api_key: encryptSecret(plain), enabled: 1, timeout_ms: 3000, data_source_id: '*', created_by: 'admin' },
    ]);
    let authHeader: string | undefined;
    setExternalKbFetch(async (_url: any, init: any) => {
      authHeader = init.headers['Authorization'];
      return new Response(JSON.stringify({ results: [{ content: 'A' }] }), { status: 200 });
    });
    await searchExternalKnowledge('ds1', 'q');
    expect(authHeader).toBe(`Bearer ${plain}`);
  });
});

describe('外部源 CRUD 落库行为', () => {
  beforeEach(() => { querySpy.mockReset(); });

  it('新增时 api_key 加密落库（enc:v1: 前缀）', async () => {
    querySpy.mockResolvedValue([[], []]);
    const id = await saveExternalKbSource(
      { name: '平台', endpoint: 'http://a/search', authType: 'bearer', apiKey: 'sk-1', timeoutMs: 5000, dataSourceId: '*', enabled: true },
      'admin'
    );
    expect(id).toMatch(/^ekb_/);
    const params = querySpy.mock.calls[0][1] as any[];
    const enc = params[4];
    expect(String(enc).startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(String(enc))).toBe('sk-1');
  });

  it('编辑时 apiKey 留空保留原密钥（UPDATE 不含 api_key 列）', async () => {
    querySpy.mockResolvedValue([[], []]);
    await saveExternalKbSource(
      { name: '平台', endpoint: 'http://a/search', authType: 'bearer', apiKey: '', timeoutMs: 5000, dataSourceId: '*', enabled: true },
      'admin',
      'ekb_fix'
    );
    const sql = querySpy.mock.calls[0][0] as string;
    expect(sql).not.toContain('api_key = ?');
    // 参数不含任何密文占位（密钥保留原值不动），末位为 WHERE id
    const params = querySpy.mock.calls[0][1] as any[];
    expect(params.every((p) => !String(p).startsWith('enc:v1:'))).toBe(true);
    expect(params[params.length - 1]).toBe('ekb_fix');
  });

  it('认证改为 none 时清空已存密钥', async () => {
    querySpy.mockResolvedValue([[], []]);
    await saveExternalKbSource(
      { name: '平台', endpoint: 'http://a/search', authType: 'none', apiKey: '', timeoutMs: 5000, dataSourceId: '*', enabled: true },
      'admin',
      'ekb_fix'
    );
    const params = querySpy.mock.calls[0][1] as any[];
    expect(params[3]).toBeNull(); // api_key 置 NULL
  });

  it('列表不泄漏密钥明文，仅返回 hasKey 标记', async () => {
    querySpy.mockResolvedValue([
      [{ id: 'ekb_1', name: '平台', endpoint: 'http://a/search', auth_type: 'bearer', api_key: encryptSecret('sk-1'), enabled: 1, timeout_ms: 5000, data_source_id: '*', created_by: 'admin' }],
      [],
    ]);
    const list = await listExternalKbSources();
    expect(list).toHaveLength(1);
    expect((list[0] as any).apiKey).toBeUndefined();
    expect(list[0].hasKey).toBe(true);
    expect(list[0].authType).toBe('bearer');
  });
});
