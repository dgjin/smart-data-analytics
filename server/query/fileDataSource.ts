/**
 * 文件数据源（v0.9.34）：上传 CSV/Excel/JSON 文件 → 服务端解析真实数据 → 落应用库物理表（upl_*），
 * 问数/报表链路经 executeSafeSql 改道应用库做真实执行（不再走演示模式）。
 *
 * 安全约束：
 * - 仅 ADMIN 上传（与数据源管理其他写操作一致）；
 * - 文件本体 ≤ MAX_FILE_BYTES（base64 净荷经 server.ts 10mb JSON 通道）；
 * - 行 ≤ MAX_FILE_ROWS、列 ≤ MAX_FILE_COLS（超出截断并在响应中如实标注）；
 * - 列名安全化为合法标识符（中文等非法表头 → f1..fN，原表头存 description 供 prompt 注入与表头中文化）；
 * - 表头命中敏感词（与 queryGuard 同一正则）整列剔除，不落库；
 * - 物理表名 upl_ 前缀白名单，DROP 前强制校验（防任意表删除）；
 * - 数据写入全参数化；删除数据源时级联 DROP 物理表（routes/datasources.ts）。
 */
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { getPool } from '../infra/db';
import { inferColumnType, toCellValue } from './analysisChain';
import { SENSITIVE_COLUMN_PATTERN } from './queryGuard';

export const FILE_TABLE_PREFIX = 'upl_';
/** 单文件行数上限（超出截断）：防止应用库膨胀 */
export const MAX_FILE_ROWS = 20000;
export const MAX_FILE_COLS = 100;
/** 上传文件本体上限：base64 膨胀约 4/3，对应 server.ts 10mb JSON 通道净荷 */
export const MAX_FILE_BYTES = 7 * 1024 * 1024;
/** 批量参数化写入每批行数 */
const INSERT_BATCH = 500;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PHYSICAL_TABLE_RE = /^upl_[a-z0-9_]+$/;

/** MySQL 保留字（表头高频命中子集）：命中即改名，避免 LLM 生成未加反引号的 SQL 直接语法错误 */
const RESERVED_WORDS = new Set([
  'order', 'group', 'key', 'desc', 'asc', 'table', 'tables', 'select', 'where', 'from', 'into',
  'values', 'set', 'update', 'delete', 'insert', 'create', 'drop', 'alter', 'union', 'join',
  'left', 'right', 'inner', 'outer', 'cross', 'on', 'as', 'and', 'or', 'not', 'null', 'in',
  'is', 'like', 'between', 'exists', 'having', 'distinct', 'if', 'case', 'when', 'then', 'else',
  'end', 'limit', 'offset', 'by', 'default', 'primary', 'foreign', 'unique', 'check', 'constraint',
  'references', 'grant', 'revoke', 'to', 'all', 'any', 'true', 'false', 'for', 'use', 'lock',
  'write', 'read', 'show', 'describe', 'explain', 'analyze', 'call', 'do', 'load', 'replace',
  'truncate', 'rename', 'index', 'view', 'trigger', 'procedure', 'function', 'database', 'schema',
]);

export type FileType = 'csv' | 'xlsx' | 'json';

/** 支持物理表落库的文件型数据源类型（csv/json/excel；demo/api 不支持） */
export function isFileDataSourceType(type: string): boolean {
  return type === 'csv' || type === 'json' || type === 'excel';
}

/** 从数据源 config 读取已登记的物理表名（严格校验 upl_ 前缀白名单，防注入） */
export function getFilePhysicalTable(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const t = (config as Record<string, unknown>).physicalTable;
  if (typeof t !== 'string') return null;
  const name = t.trim().toLowerCase();
  return PHYSICAL_TABLE_RE.test(name) ? name : null;
}

export interface ParsedFileData {
  headers: string[];
  rows: unknown[][];
  /** 行或列因超限被截断 */
  truncated: boolean;
}

export interface SanitizedColumns {
  columns: { name: string; description: string; sourceIndex: number }[];
  /** 因命中敏感词被整体剔除的表头（原样返回供提示） */
  droppedSensitive: string[];
}

/**
 * 表头 → 安全列名：合法标识符且非保留字直接用；中文/非法字符/冲突 → f{列序号}（再冲突追加 _x 后缀）；
 * 空表头命名「列N」；命中敏感词的列整体剔除（不落库、不进 Schema）。
 * sourceIndex 记录原表头下标，供行数据投影对齐。
 */
export function sanitizeColumns(headers: string[]): SanitizedColumns {
  const used = new Set<string>();
  const columns: { name: string; description: string; sourceIndex: number }[] = [];
  const droppedSensitive: string[] = [];
  headers.forEach((raw, i) => {
    const header = String(raw ?? '').trim().slice(0, 200) || `列${i + 1}`;
    if (SENSITIVE_COLUMN_PATTERN.test(header)) {
      droppedSensitive.push(header);
      return;
    }
    let name: string;
    if (IDENT_RE.test(header) && !RESERVED_WORDS.has(header.toLowerCase()) && !used.has(header.toLowerCase())) {
      name = header;
    } else {
      name = `f${i + 1}`;
      while (used.has(name.toLowerCase())) name = `${name}_x`;
    }
    used.add(name.toLowerCase());
    columns.push({ name, description: header, sourceIndex: i });
  });
  return { columns, droppedSensitive };
}

/** 逐列推断物理类型（复用中间表清洗链同一推断逻辑：样本数值占比 ≥60% → DOUBLE） */
export function inferFileColumnTypes(rows: unknown[][], colCount: number): ('DOUBLE' | 'TEXT')[] {
  const sample = rows.slice(0, 100).map((r) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < colCount; i++) obj[String(i)] = r[i];
    return obj;
  });
  return Array.from({ length: colCount }, (_, i) => inferColumnType(sample as Record<string, any>[], String(i)));
}

/** exceljs 单元格值规整：富文本/超链接/公式取结果；日期转 'YYYY-MM-DD HH:mm:ss' 串；异常对象转 JSON 截断 */
function cellToValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  if (typeof v === 'object') {
    const obj = v as unknown as Record<string, unknown>;
    if (Array.isArray(obj.richText)) return (obj.richText as { text?: string }[]).map((t) => t.text || '').join('');
    if (typeof obj.text === 'string') return obj.text; // 超链接
    if ('result' in obj) return cellToValue(obj.result as ExcelJS.CellValue); // 公式取计算结果
    if ('error' in obj) return null;
    return JSON.stringify(v).slice(0, 200);
  }
  return v;
}

/** 原始行列统一截断（列上限对 headers 与每行同时生效） */
function capData(headers: string[], rows: unknown[][]): ParsedFileData {
  const truncatedCols = headers.length > MAX_FILE_COLS;
  const truncatedRows = rows.length > MAX_FILE_ROWS;
  const cols = Math.min(headers.length, MAX_FILE_COLS);
  return {
    headers: headers.slice(0, cols),
    rows: rows.slice(0, MAX_FILE_ROWS).map((r) => r.slice(0, cols)),
    truncated: truncatedCols || truncatedRows,
  };
}

/** 解析上传文件为统一行列结构（csv→papaparse；xlsx→exceljs 首个工作表；json→对象数组或二维数组） */
export async function parseFileContent(fileType: FileType, buf: Buffer): Promise<ParsedFileData> {
  if (fileType === 'csv') {
    // 去 BOM；papaparse 自动识别分隔符，skipEmptyLines greedy 剔除空行
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const out = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
    const rows = (out.data || []).filter((r) => Array.isArray(r) && r.length > 0);
    if (rows.length === 0) throw new Error('CSV 文件没有可解析的数据行');
    const headers = rows[0].map((h) => String(h ?? ''));
    return capData(headers, rows.slice(1).map((r) => r.map((v) => (typeof v === 'string' ? v : String(v ?? '')))));
  }
  if (fileType === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Excel 文件中没有工作表');
    const grid: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1); // row.values 首元素为 undefined（1-based）
      grid.push(values.map(cellToValue));
    });
    if (grid.length === 0) throw new Error('Excel 工作表中没有数据行');
    const colCount = Math.max(...grid.map((r) => r.length));
    const headers = Array.from({ length: colCount }, (_, i) => String(grid[0][i] ?? ''));
    return capData(headers, grid.slice(1));
  }
  // json：数组 of 对象（表头为键并集，按出现顺序）或二维数组（首行为表头）
  const data: unknown = JSON.parse(buf.toString('utf8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('JSON 文件应为非空数组（对象数组或二维数组）');
  if (Array.isArray(data[0])) {
    const grid = data as unknown[][];
    return capData(grid[0].map((h) => String(h ?? '')), grid.slice(1));
  }
  if (typeof data[0] === 'object' && data[0] !== null) {
    const headers: string[] = [];
    for (const row of data) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('JSON 数组元素类型不一致：应全为对象或全为数组');
      for (const k of Object.keys(row)) if (!headers.includes(k)) headers.push(k);
    }
    const rows = (data as Record<string, unknown>[]).map((r) => headers.map((h) => r[h]));
    return capData(headers, rows);
  }
  throw new Error('JSON 数组元素应为对象或数组');
}

/** 建物理表并参数化批量写入（先 DROP 同名残留——表名含唯一后缀，正常不会撞车） */
export async function createFileTable(
  physicalTable: string,
  columns: { name: string }[],
  types: ('DOUBLE' | 'TEXT')[],
  rows: unknown[][]
): Promise<void> {
  if (!PHYSICAL_TABLE_RE.test(physicalTable)) throw new Error('非法物理表名');
  const pool = getPool();
  const colDefs = columns.map((c, i) => `\`${c.name}\` ${types[i]} NULL`).join(', ');
  await pool.query(`DROP TABLE IF EXISTS \`${physicalTable}\``);
  await pool.query(`CREATE TABLE \`${physicalTable}\` (${colDefs}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const colList = columns.map((c) => `\`${c.name}\``).join(', ');
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const values = batch.map((r) => columns.map((_, ci) => toCellValue(r[ci], types[ci])));
    await pool.query(`INSERT INTO \`${physicalTable}\` (${colList}) VALUES ?`, [values]);
  }
}

/** 级联删除物理表（仅 upl_ 前缀白名单；删除失败由调用方决定告警或阻断） */
export async function dropFileTable(physicalTable: string): Promise<void> {
  if (!PHYSICAL_TABLE_RE.test(physicalTable)) throw new Error('非法物理表名');
  await getPool().query(`DROP TABLE IF EXISTS \`${physicalTable}\``);
}
