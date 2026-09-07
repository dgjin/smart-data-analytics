/**
 * v0.9.34 文件数据源单测：列名安全化（保留字/中文/冲突/敏感剔除）、类型推断、
 * CSV/JSON/XLSX 解析与截断、建表批量写入（参数化 + 分批）、物理表名白名单 DROP。
 * 连接池 mock，不触碰真实 MySQL；路由端点的编排在 routes/datasources.ts（薄胶水层）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

// 注入假连接池：验证建表/写入/DROP 的 SQL 与参数，不依赖真实数据库
const queryMock = vi.fn(async (..._args: any[]): Promise<any> => [[], []]);
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: any[]) => queryMock(...args) }) }));
vi.mock('../llm/llmClient', () => ({ callLLMJson: vi.fn(), sqlStageRoute: () => null }));

import {
  FILE_TABLE_PREFIX,
  MAX_FILE_BYTES,
  MAX_FILE_COLS,
  MAX_FILE_ROWS,
  createFileTable,
  dropFileTable,
  getFilePhysicalTable,
  inferFileColumnTypes,
  isFileDataSourceType,
  parseFileContent,
  sanitizeColumns,
} from './fileDataSource';

beforeEach(() => {
  queryMock.mockClear();
});

describe('isFileDataSourceType: 文件型数据源判定', () => {
  it('csv/json/excel 支持落库', () => {
    for (const t of ['csv', 'json', 'excel']) expect(isFileDataSourceType(t)).toBe(true);
  });

  it('数据库型与 demo/api 不支持', () => {
    for (const t of ['mysql', 'postgresql', 'greenplum', 'demo', 'api', '']) {
      expect(isFileDataSourceType(t)).toBe(false);
    }
  });
});

describe('getFilePhysicalTable: 物理表名白名单读取', () => {
  it('合法 upl_* 表名放行（大写归一为小写）', () => {
    expect(getFilePhysicalTable({ physicalTable: 'upl_1700000000000' })).toBe('upl_1700000000000');
    expect(getFilePhysicalTable({ physicalTable: 'UPL_ABC' })).toBe('upl_abc');
  });

  it('非 upl_ 前缀 / 注入形态 / 非字符串一律拒绝', () => {
    expect(getFilePhysicalTable({ physicalTable: 'users' })).toBeNull();
    expect(getFilePhysicalTable({ physicalTable: 'ait_x1' })).toBeNull();
    expect(getFilePhysicalTable({ physicalTable: 'upl_x`; DROP TABLE users; --' })).toBeNull();
    expect(getFilePhysicalTable({ physicalTable: 'upl_x.users' })).toBeNull();
    expect(getFilePhysicalTable({ physicalTable: 'upl_' })).toBeNull();
    expect(getFilePhysicalTable({ physicalTable: 123 })).toBeNull();
    expect(getFilePhysicalTable({})).toBeNull();
    expect(getFilePhysicalTable(null)).toBeNull();
    expect(getFilePhysicalTable('upl_abc')).toBeNull();
  });
});

describe('sanitizeColumns: 表头安全化', () => {
  it('合法标识符直接用，中文/非法字符改名 f{序号}，原表头存 description', () => {
    const { columns, droppedSensitive } = sanitizeColumns(['id', '城市', 'amount']);
    expect(droppedSensitive).toEqual([]);
    expect(columns).toEqual([
      { name: 'id', description: 'id', sourceIndex: 0 },
      { name: 'f2', description: '城市', sourceIndex: 1 },
      { name: 'amount', description: 'amount', sourceIndex: 2 },
    ]);
  });

  it('MySQL 保留字命中即改名（防 LLM 生成未加反引号的 SQL 语法错误）', () => {
    const { columns } = sanitizeColumns(['order', 'SELECT', 'amount']);
    expect(columns.map((c) => c.name)).toEqual(['f1', 'f2', 'amount']);
    expect(columns[0].description).toBe('order');
    expect(columns[1].description).toBe('SELECT');
  });

  it('空表头命名「列N」并按非法字符改名', () => {
    const { columns } = sanitizeColumns(['', '  ', 'x']);
    expect(columns[0]).toEqual({ name: 'f1', description: '列1', sourceIndex: 0 });
    expect(columns[1]).toEqual({ name: 'f2', description: '列2', sourceIndex: 1 });
    expect(columns[2]).toEqual({ name: 'x', description: 'x', sourceIndex: 2 });
  });

  it('大小写冲突去重（Name/name 不撞列）', () => {
    const { columns } = sanitizeColumns(['Name', 'name']);
    expect(columns[0].name).toBe('Name');
    expect(columns[1].name).toBe('f2');
  });

  it('fN 命名冲突追加 _x 后缀', () => {
    const { columns } = sanitizeColumns(['f2', '城市']);
    expect(columns[0].name).toBe('f2');
    expect(columns[1].name).toBe('f2_x');
  });

  it('敏感列整列剔除，保留列 sourceIndex 维持原始下标（供行数据投影对齐）', () => {
    const { columns, droppedSensitive } = sanitizeColumns(['城市', '密码', 'id_card', '金额']);
    expect(droppedSensitive).toEqual(['密码', 'id_card']);
    expect(columns).toEqual([
      { name: 'f1', description: '城市', sourceIndex: 0 },
      { name: 'f4', description: '金额', sourceIndex: 3 },
    ]);
  });

  it('投影契约：按 sourceIndex 取行值与剔除后列一一对应（import-file 端点依赖）', () => {
    const { columns } = sanitizeColumns(['城市', '密码', '金额']);
    const rawRow = ['北京', 'p@ss', '100.5'];
    const projected = columns.map((c) => rawRow[c.sourceIndex]);
    expect(projected).toEqual(['北京', '100.5']);
  });
});

describe('inferFileColumnTypes: 列类型推断（≥60% 数值 → DOUBLE）', () => {
  it('数值占比 ≥60% → DOUBLE，否则 TEXT', () => {
    // 4 行中 3 行数值（75%）→ DOUBLE；3 行中 1 行数值（33%）→ TEXT
    const types = inferFileColumnTypes(
      [
        ['1', '甲'],
        ['2', '乙'],
        ['3', '1'],
        ['x', '丙'],
      ],
      2,
    );
    expect(types).toEqual(['DOUBLE', 'TEXT']);
  });

  it('空值不计入分母：唯一非空值是数值 → DOUBLE；全空 → TEXT', () => {
    expect(inferFileColumnTypes([[''], [''], ['5']], 1)).toEqual(['DOUBLE']);
    expect(inferFileColumnTypes([[''], [null], [undefined]], 1)).toEqual(['TEXT']);
  });

  it('number 类型样本同样识别', () => {
    expect(inferFileColumnTypes([[100.5], [2], [3]], 1)).toEqual(['DOUBLE']);
  });
});

describe('parseFileContent: CSV', () => {
  it('基础解析：首行表头 + 数据行；BOM 剥除；空行跳过', async () => {
    const buf = Buffer.from('\uFEFFname,age\n张三,30\n\n李四,25\n', 'utf8');
    const out = await parseFileContent('csv', buf);
    expect(out.headers).toEqual(['name', 'age']);
    expect(out.rows).toEqual([
      ['张三', '30'],
      ['李四', '25'],
    ]);
    expect(out.truncated).toBe(false);
  });

  it('无可解析行抛错；仅表头返回空数据行（由端点判 400）', async () => {
    await expect(parseFileContent('csv', Buffer.from('', 'utf8'))).rejects.toThrow('CSV');
    const headerOnly = await parseFileContent('csv', Buffer.from('a,b\n', 'utf8'));
    expect(headerOnly.headers).toEqual(['a', 'b']);
    expect(headerOnly.rows).toEqual([]);
  });

  it('列数超过 MAX_FILE_COLS 截断并标注 truncated', async () => {
    const headers = Array.from({ length: MAX_FILE_COLS + 5 }, (_, i) => `c${i}`);
    const row = Array.from({ length: MAX_FILE_COLS + 5 }, (_, i) => String(i));
    const csv = `${headers.join(',')}\n${row.join(',')}\n`;
    const out = await parseFileContent('csv', Buffer.from(csv, 'utf8'));
    expect(out.headers.length).toBe(MAX_FILE_COLS);
    expect(out.rows[0].length).toBe(MAX_FILE_COLS);
    expect(out.truncated).toBe(true);
  });

  it('行数超过 MAX_FILE_ROWS 截断并标注 truncated', async () => {
    const lines = ['a'];
    for (let i = 0; i < MAX_FILE_ROWS + 3; i++) lines.push(String(i));
    const out = await parseFileContent('csv', Buffer.from(lines.join('\n'), 'utf8'));
    expect(out.rows.length).toBe(MAX_FILE_ROWS);
    expect(out.truncated).toBe(true);
  });
});

describe('parseFileContent: JSON', () => {
  it('对象数组：表头为键并集（按出现顺序），缺键行为 undefined', async () => {
    const buf = Buffer.from(JSON.stringify([{ a: 1, b: 'x' }, { a: 2, c: true }]), 'utf8');
    const out = await parseFileContent('json', buf);
    expect(out.headers).toEqual(['a', 'b', 'c']);
    expect(out.rows).toEqual([
      [1, 'x', undefined],
      [2, undefined, true],
    ]);
  });

  it('二维数组：首行为表头', async () => {
    const buf = Buffer.from(JSON.stringify([['name', 'v'], ['甲', 1], ['乙', 2]]), 'utf8');
    const out = await parseFileContent('json', buf);
    expect(out.headers).toEqual(['name', 'v']);
    expect(out.rows).toEqual([
      ['甲', 1],
      ['乙', 2],
    ]);
  });

  it('非数组 / 空数组 / 元素类型混杂均抛错', async () => {
    await expect(parseFileContent('json', Buffer.from('{"a":1}', 'utf8'))).rejects.toThrow();
    await expect(parseFileContent('json', Buffer.from('[]', 'utf8'))).rejects.toThrow();
    await expect(parseFileContent('json', Buffer.from('[{"a":1},[1,2]]', 'utf8'))).rejects.toThrow('类型不一致');
    await expect(parseFileContent('json', Buffer.from('[1,2,3]', 'utf8'))).rejects.toThrow();
    await expect(parseFileContent('json', Buffer.from('{bad json', 'utf8'))).rejects.toThrow();
  });
});

describe('parseFileContent: XLSX', () => {
  it('首个工作表解析：字符串/数值/日期/超链接/公式结果规整', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('销售');
    ws.addRow(['城市', '销售额', '日期', '链接', '合计']);
    ws.addRow(['北京', 100.5, new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), { text: '明细', hyperlink: 'https://example.com' }, null]);
    ws.addRow(['上海', 200, null, null, { formula: 'B2+B3', result: 300.5 }]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const out = await parseFileContent('xlsx', buf);
    expect(out.headers).toEqual(['城市', '销售额', '日期', '链接', '合计']);
    expect(out.rows[0][0]).toBe('北京');
    expect(out.rows[0][1]).toBe(100.5);
    expect(out.rows[0][2]).toBe('2026-01-02 03:04:05'); // Date → 'YYYY-MM-DD HH:mm:ss'
    expect(out.rows[0][3]).toBe('明细'); // 超链接取 text
    expect(out.rows[1][4]).toBe(300.5); // 公式取计算结果
  });

  it('空工作表抛错；非 xlsx 内容抛错', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('空表');
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseFileContent('xlsx', buf)).rejects.toThrow('没有数据行');
    await expect(parseFileContent('xlsx', Buffer.from('not a zip', 'utf8'))).rejects.toThrow();
  });
});

describe('createFileTable: 建表与参数化批量写入', () => {
  it('非法物理表名直接拒绝（不触库）', async () => {
    await expect(createFileTable('users', [{ name: 'a' }], ['TEXT'], [['1']])).rejects.toThrow('非法物理表名');
    await expect(createFileTable('upl_x`; DROP TABLE users; --', [{ name: 'a' }], ['TEXT'], [['1']])).rejects.toThrow('非法物理表名');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('DROP 残留 → CREATE → 单批 INSERT；值经 toCellValue 规整（DOUBLE 非数值→null）', async () => {
    await createFileTable(
      `${FILE_TABLE_PREFIX}t1`,
      [{ name: 'f1' }, { name: 'amount' }],
      ['TEXT', 'DOUBLE'],
      [
        ['北京', '100.5'],
        ['上海', 'abc'],
      ],
    );
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(queryMock.mock.calls[0][0]).toBe('DROP TABLE IF EXISTS `upl_t1`');
    expect(queryMock.mock.calls[1][0]).toBe('CREATE TABLE `upl_t1` (`f1` TEXT NULL, `amount` DOUBLE NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    expect(queryMock.mock.calls[2][0]).toBe('INSERT INTO `upl_t1` (`f1`, `amount`) VALUES ?');
    expect(queryMock.mock.calls[2][1]).toEqual([
      [
        ['北京', 100.5],
        ['上海', null],
      ],
    ]);
  });

  it('超过 500 行分批写入（1200 行 → 3 批：500/500/200）', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => [i]);
    await createFileTable('upl_batch', [{ name: 'v' }], ['DOUBLE'], rows);
    // 1 DROP + 1 CREATE + 3 INSERT
    expect(queryMock).toHaveBeenCalledTimes(5);
    const insertCalls = queryMock.mock.calls.slice(2);
    expect(insertCalls.map((c) => c[1][0].length)).toEqual([500, 500, 200]);
  });
});

describe('dropFileTable: 级联删除白名单', () => {
  it('合法 upl_* 表名执行 DROP TABLE IF EXISTS', async () => {
    await dropFileTable('upl_1700000000000');
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toBe('DROP TABLE IF EXISTS `upl_1700000000000`');
  });

  it('非法表名拒绝（防任意表删除），不触库', async () => {
    await expect(dropFileTable('users')).rejects.toThrow('非法物理表名');
    await expect(dropFileTable('data_sources')).rejects.toThrow('非法物理表名');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('上传约束常量', () => {
  it('文件本体 7MB / 2 万行 / 100 列（与前端预检和 10mb JSON 通道对齐）', () => {
    expect(MAX_FILE_BYTES).toBe(7 * 1024 * 1024);
    expect(MAX_FILE_ROWS).toBe(20000);
    expect(MAX_FILE_COLS).toBe(100);
  });
});
