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

/**
 * 读取已登记的物理表名列表（兼容单表 physicalTable 与多表 physicalTables 数组，如内置演示数据集 3 张表）。
 * 全部经 upl_ 前缀白名单校验；供删除级联逐表清理。
 */
export function getFilePhysicalTables(config: unknown): string[] {
  const list: string[] = [];
  const single = getFilePhysicalTable(config);
  if (single) list.push(single);
  if (config && typeof config === 'object') {
    const multi = (config as Record<string, unknown>).physicalTables;
    if (Array.isArray(multi)) {
      for (const t of multi) {
        const name = typeof t === 'string' ? t.trim().toLowerCase() : '';
        if (PHYSICAL_TABLE_RE.test(name) && !list.includes(name)) list.push(name);
      }
    }
  }
  return list;
}

export interface ParsedFileData {
  headers: string[];
  rows: unknown[][];
  /** 行或列因超限被截断 */
  truncated: boolean;
  /** 表头起始行（1-based，含自动跳过的标题/说明行）；1 表示首行即表头 */
  headerRow?: number;
  /** 表头行数：1=单行；2=两级表头已合并列名 */
  headerRows?: number;
  /** 表头来源：auto=系统自动识别，manual=用户在导入前手动指定（v0.9.121） */
  headerMode?: 'auto' | 'manual';
}

/** 金额源单位白名单（与问数金额单位选项同口径） */
export type HeaderUnit = '元' | '万元' | '百万元' | '亿元';

/**
 * 表头金额单位提取（v0.9.122）：只认显式标注，不猜测。
 * 命中「(万元)」「（亿元）」「单位:万元」等写法返回单位；未标注返回 undefined。
 * 用于文件数据源问数时按源单位换算——未标注的金额列一律按原值呈现，不再默认当作「元」。
 */
export function extractHeaderUnit(header: string): HeaderUnit | undefined {
  const s = String(header ?? '');
  const m = s.match(/[（(]\s*(百万元|亿元|万元|元)\s*[）)]/) || s.match(/单位\s*[:：]\s*(百万元|亿元|万元|元)/);
  return (m?.[1] as HeaderUnit) || undefined;
}

export interface SanitizedColumns {
  columns: { name: string; description: string; sourceIndex: number; unit?: HeaderUnit }[];
  /** 因命中敏感词被整体剔除的表头（原样返回供提示） */
  droppedSensitive: string[];
}

/**
 * 表头 → 安全列名：合法标识符且非保留字直接用；中文/非法字符/冲突 → f{列序号}（再冲突追加 _x 后缀）；
 * 空表头命名「列N」；命中敏感词的列整体剔除（不落库、不进 Schema）。
 * sourceIndex 记录原表头下标，供行数据投影对齐。
 * v0.9.122：表头显式标注的金额单位（如「预计回现(万元)」）随列写入元数据。
 */
export function sanitizeColumns(headers: string[]): SanitizedColumns {
  const used = new Set<string>();
  const columns: { name: string; description: string; sourceIndex: number; unit?: HeaderUnit }[] = [];
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
    const unit = extractHeaderUnit(header);
    columns.push({ name, description: header, sourceIndex: i, ...(unit ? { unit } : {}) });
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
  return Array.from({ length: colCount }, (_, i) => inferColumnType(sample, String(i)));
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

/** 表头扫描窗口：只在前 20 行内找表头，再往后就不是「标题/说明行」而是数据了 */
const HEADER_SCAN_ROWS = 20;
/** 数值/百分比单元格（含千分位），用于区分表头标签与数据 */
const NUMERIC_CELL_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
/** 常见日期串（2026-01-02 / 2026/1/2 / 2026年1月2日） */
const DATE_CELL_RE = /^\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?(?:[ T].*)?$/;

const isBlankCell = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === '';

/** 数值或日期单元格：表头行几乎不含这类值，数据行通常以它们为主 */
export function isMeasureCell(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return NUMERIC_CELL_RE.test(s) || DATE_CELL_RE.test(s);
}

/** 单元格文本（非字符串转字符串，空值返回空串） */
function cellText(v: unknown): string {
  if (isBlankCell(v)) return '';
  return String(v).trim();
}

interface RowShape {
  /** 非空单元格数 */
  nonBlank: number;
  /** 非空占列数比例 */
  fill: number;
  /** 非空单元格中「非数值/日期」占比 */
  textRatio: number;
  /** 不同值个数（合并标题行会退化为 1） */
  unique: number;
  /** 文本单元格中超 40 字的占比（说明行长句多） */
  longRatio: number;
}

function shapeRow(row: unknown[] | undefined, colCount: number): RowShape {
  const cells = Array.from({ length: colCount }, (_, i) => row?.[i]);
  const nonBlankCells = cells.filter((v) => !isBlankCell(v));
  const nonBlank = nonBlankCells.length;
  const textCells = nonBlankCells.filter((v) => !isMeasureCell(v));
  return {
    nonBlank,
    fill: nonBlank / colCount,
    textRatio: nonBlank === 0 ? 0 : textCells.length / nonBlank,
    unique: new Set(nonBlankCells.map((v) => String(v).trim())).size,
    longRatio: textCells.length === 0 ? 0 : textCells.filter((v) => cellText(v).length > 40).length / textCells.length,
  };
}

/**
 * 形状上是否可能是一级表头：填充度 ≥60%、以短文本为主。
 * 数值为主的行是数据行；只有一格有值的多为合并标题或说明行；长句为说明行。
 */
function looksLikeHeader(s: RowShape, colCount: number): boolean {
  if (s.nonBlank === 0) return false;
  if (colCount > 1 && s.nonBlank < 2) return false;
  if (s.fill < 0.6) return false;
  if (s.textRatio < 0.8) return false;
  if (s.longRatio > 0.2) return false;
  return true;
}

/**
 * 下一行是否比当前行更像表头：合并标题行在 ExcelJS 读取时会填充整行且值唯一，
 * 因此「唯一值更多」即可把标题行与真正的表头行区分开；其次比较填充度。
 */
function moreHeaderLike(cur: RowShape, next: RowShape): boolean {
  if (next.unique > cur.unique) return true;
  return next.unique === cur.unique && next.fill > cur.fill + 0.2;
}

export interface DetectedHeader {
  headers: string[];
  rows: unknown[][];
  /** 表头起始行（1-based） */
  headerRow: number;
  /** 表头行数（1 或 2） */
  headerRows: number;
}

/**
 * 自动识别表头起始行（v0.9.120）。
 *
 * 背景：Excel 报表首行常是合并标题（「2026 年三季度客户经营明细表」）或口径说明行，
 * 直接取 grid[0] 会把标题当列名（全列同名）、把真表头当数据写进物理表。
 * 策略：
 * 1) 在前 20 行内找「形状上是表头」的行（填充度、短文本、非数值）；
 * 2) 若下一行更像表头（唯一值更多）则跳过——排除合并标题行；
 * 3) 命中后若下一行仍是纯文本短标签、且再下一行才出现数值/日期，则视为两级表头，
 *    列名合并为「父-子」（子名以父名开头时只用子名，避免「回收-回收率」这类冗余）；
 * 4) 找不到合格行时回退首行，保证「首行即表头」的既有文件行为完全不变。
 */
export function detectTableHeader(grid: unknown[][], colCount: number): DetectedHeader {
  const limit = Math.min(HEADER_SCAN_ROWS, Math.max(0, grid.length - 1));
  let start = 0;
  for (let i = 0; i < limit; i++) {
    const cur = shapeRow(grid[i], colCount);
    if (!looksLikeHeader(cur, colCount)) continue;
    const next = shapeRow(grid[i + 1], colCount);
    if (looksLikeHeader(next, colCount) && moreHeaderLike(cur, next)) continue;
    start = i;
    break;
  }

  const first = shapeRow(grid[start], colCount);
  const second = shapeRow(grid[start + 1], colCount);
  const after = grid[start + 2];
  const afterHasMeasure = Array.isArray(after) && after.some((v) => isMeasureCell(v));
  // 两级表头：父行必须有合并痕迹（重复值或空列），子行为纯文本短标签，数据从第三行开始
  const hasMergeTrace = first.unique < first.nonBlank || first.nonBlank < colCount;
  const headerRows =
    hasMergeTrace && afterHasMeasure && second.fill >= 0.6 && second.textRatio >= 0.9 && second.longRatio <= 0.2
      ? 2
      : 1;

  return assembleHeader(grid, start, headerRows, colCount);
}

/** 手动表头选择（v0.9.121）：用户在导入预览中点选起始行与行数 */
export interface HeaderSelection {
  /** 表头起始行（1-based） */
  headerRow?: number;
  /** 表头行数：1=单行；2=两级表头合并列名 */
  headerRows?: 1 | 2;
}

/**
 * 按指定起始行与行数组装列名与数据行（自动识别与手动指定共用同一合并规则）：
 * 两级表头列名合并为「父-子」；子名以父名开头时只取子名，避免「回收-回收率」冗余。
 */
function assembleHeader(grid: unknown[][], start: number, headerRows: 1 | 2, colCount: number): DetectedHeader {
  const headerCells = grid[start] || [];
  const subCells = headerRows === 2 ? grid[start + 1] || [] : [];
  const headers = Array.from({ length: colCount }, (_, j) => {
    const parent = cellText(headerCells[j]);
    if (headerRows === 1) return parent;
    const child = cellText(subCells[j]);
    if (!parent) return child;
    if (!child || child === parent) return parent;
    return child.startsWith(parent) ? child : `${parent}-${child}`;
  });
  return { headers, rows: grid.slice(start + headerRows), headerRow: start + 1, headerRows };
}

/** 手动表头合法性校验：越界或非法行数明确报错，不静默回退自动识别 */
function assembleManual(grid: unknown[][], colCount: number, selection: HeaderSelection): DetectedHeader {
  const headerRow = selection.headerRow;
  const headerRows = selection.headerRows ?? 1;
  if (typeof headerRow !== 'number' || !Number.isInteger(headerRow) || headerRow < 1) {
    throw new Error('表头行号必须是从 1 开始的整数');
  }
  if (headerRows !== 1 && headerRows !== 2) throw new Error('表头行数只能是 1 或 2');
  if (headerRow + headerRows - 1 > grid.length) {
    throw new Error(`表头行号超出文件范围（共 ${grid.length} 行，选择第 ${headerRow} 行${headerRows === 2 ? '起两行' : ''}）`);
  }
  return assembleHeader(grid, headerRow - 1, headerRows, colCount);
}

/** 识别/指定表头后统一截断（保留 headerRow/headerRows/headerMode 供端点如实告知） */
function capDetected(grid: unknown[][], colCount: number, selection?: HeaderSelection): ParsedFileData {
  const manual = selection?.headerRow !== undefined;
  const detected = manual ? assembleManual(grid, colCount, selection as HeaderSelection) : detectTableHeader(grid, colCount);
  const capped = capData(detected.headers, detected.rows);
  return {
    ...capped,
    headerRow: detected.headerRow,
    headerRows: detected.headerRows,
    headerMode: manual ? 'manual' : 'auto',
  };
}

/** 原始网格（未选表头）：JSON 对象数组额外携带固定表头（键并集，不可手动选择） */
interface ExtractedGrid {
  grid: unknown[][];
  colCount: number;
  fixedHeader?: string[];
}

/** 从三种文件格式提取统一二维网格（不含表头识别，供导入解析与预览共用） */
async function extractGrid(fileType: FileType, buf: Buffer): Promise<ExtractedGrid> {
  if (fileType === 'csv') {
    // 去 BOM；papaparse 自动识别分隔符，skipEmptyLines greedy 剔除空行
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const out = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
    const rows = (out.data || []).filter((r) => Array.isArray(r) && r.length > 0);
    if (rows.length === 0) throw new Error('CSV 文件没有可解析的数据行');
    const grid = rows.map((r) => r.map((v) => (typeof v === 'string' ? v : String(v ?? ''))));
    return { grid, colCount: Math.max(...grid.map((r) => r.length)) };
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
    return { grid, colCount: Math.max(...grid.map((r) => r.length)) };
  }
  // json：数组 of 对象（表头为键并集，按出现顺序）或二维数组（自动识别表头行）
  const data: unknown = JSON.parse(buf.toString('utf8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error('JSON 文件应为非空数组（对象数组或二维数组）');
  if (Array.isArray(data[0])) {
    const grid = data as unknown[][];
    return { grid, colCount: Math.max(...grid.map((r) => (Array.isArray(r) ? r.length : 0))) };
  }
  if (typeof data[0] === 'object' && data[0] !== null) {
    const headers: string[] = [];
    for (const row of data) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('JSON 数组元素类型不一致：应全为对象或全为数组');
      for (const k of Object.keys(row)) if (!headers.includes(k)) headers.push(k);
    }
    const rows = (data as Record<string, unknown>[]).map((r) => headers.map((h) => r[h]));
    // 对象数组的「表头」是键，合成首行供预览展示；fixedHeader 标记不允许手动改选
    return { grid: [headers, ...rows], colCount: headers.length, fixedHeader: headers };
  }
  throw new Error('JSON 数组元素应为对象或数组');
}

/** 解析上传文件为统一行列结构（csv→papaparse；xlsx→exceljs 首个工作表；json→对象数组或二维数组） */
export async function parseFileContent(
  fileType: FileType,
  buf: Buffer,
  selection?: HeaderSelection
): Promise<ParsedFileData> {
  const { grid, colCount, fixedHeader } = await extractGrid(fileType, buf);
  if (fixedHeader) {
    // JSON 对象数组以键为列名，无「表头行」概念，忽略手动选择
    return { ...capData(fixedHeader, grid.slice(1)), headerRow: 1, headerRows: 1, headerMode: 'auto' };
  }
  return capDetected(grid, colCount, selection);
}

/** 预览候选：前 20 行每行都给出「单行表头」与「两级表头」两种列名，供前端切换即时回显 */
export interface HeaderCandidate {
  headerRow: number;
  headerRows: 1 | 2;
  headers: string[];
}

export interface FilePreview {
  /** 前 N 行原始单元格（文本化，列数已截断到 MAX_FILE_COLS） */
  rows: string[][];
  columns: number;
  /** 原始总行数（含标题行） */
  totalRows: number;
  /** 自动识别结果 */
  detected: { headerRow: number; headerRows: 1 | 2; headers: string[] };
  candidates: HeaderCandidate[];
  /** false = JSON 对象数组（键即列名），无需/不可选择表头 */
  supportsHeaderSelection: boolean;
  /** 导入时是否会触发行/列截断 */
  truncated: boolean;
}

/** 预览展示行数（与表头扫描窗口一致） */
const PREVIEW_ROWS = 20;

/** 预览单元格文本化：空值空串、对象 JSON 串、统一截 200 字 */
function previewCell(v: unknown): string {
  if (isBlankCell(v)) return '';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 200);
  return String(v).trim().slice(0, 200);
}

/**
 * 解析预览（v0.9.121）：返回前 20 行 + 自动识别结果 + 每行候选列名，不落库。
 * 前端据此让用户点选真正的表头行（及是否两级表头），再带 headerRow/headerRows 正式导入。
 */
export async function parseFilePreview(fileType: FileType, buf: Buffer, limit = PREVIEW_ROWS): Promise<FilePreview> {
  const { grid, colCount, fixedHeader } = await extractGrid(fileType, buf);
  const cols = Math.min(colCount, MAX_FILE_COLS);
  const rows = grid.slice(0, Math.max(1, limit)).map((r) => Array.from({ length: cols }, (_, j) => previewCell(r?.[j])));
  let detected: FilePreview['detected'];
  if (fixedHeader) {
    detected = { headerRow: 1, headerRows: 1, headers: fixedHeader.slice(0, cols) };
  } else {
    const d = detectTableHeader(grid, colCount);
    detected = { headerRow: d.headerRow, headerRows: d.headerRows as 1 | 2, headers: d.headers.slice(0, cols) };
  }
  const dataRows = grid.length - (detected.headerRow - 1 + detected.headerRows);
  const candidates: HeaderCandidate[] = fixedHeader
    ? []
    : Array.from({ length: Math.min(PREVIEW_ROWS, grid.length) }, (_, i) => i).flatMap((i) => {
        const one: HeaderCandidate = {
          headerRow: i + 1,
          headerRows: 1,
          headers: assembleHeader(grid, i, 1, colCount).headers.slice(0, cols),
        };
        if (i + 1 >= grid.length) return [one];
        const two: HeaderCandidate = {
          headerRow: i + 1,
          headerRows: 2,
          headers: assembleHeader(grid, i, 2, colCount).headers.slice(0, cols),
        };
        return [one, two];
      });
  return {
    rows,
    columns: cols,
    totalRows: grid.length,
    detected,
    candidates,
    supportsHeaderSelection: !fixedHeader,
    truncated: colCount > MAX_FILE_COLS || dataRows > MAX_FILE_ROWS,
  };
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
