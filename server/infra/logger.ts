/**
 * v0.9.93 统一日志出口（自动运维 P0-1 结构化升级）：
 * 服务端运行时代码一律经 logger 输出，替代散落的 console.*。
 *
 * - 默认 JSON Lines（每行一个 JSON 对象，供自动运维智能体 / jq / Loki 消费）：
 *   ts/level/msg 必带；requestId/userId/username/taskId/taskType 由 asyncContext
 *   （AsyncLocalStorage）自动注入；Error 对象提取为 err{name,message,code,errno,stack}；
 *   msg 的 [Module] 前缀（现有约定，如 [TaskQueue]/[HTTP]）提取为 module 字段供按模块过滤；
 *   其余实参经安全序列化（截断超长、循环引用兜底）进 args 字段。
 * - 输出格式自适应：LOG_FORMAT=json|pretty 显式指定；未指定时按 stdout 是否 TTY——
 *   重定向到文件/管道/容器（start.sh、docker、CI）→ JSONL；交互终端 → 人类可读（带时间戳与级别前缀）。
 * - 落盘即时性：JSON 行经 fs.writeSync 同步写 fd（warn/error → stderr，debug/info → stdout），
 *   消除异步缓冲导致的"日志延迟数分钟才可见"问题——tail / 智能体实时消费依赖此保证。
 * - 级别：LOG_LEVEL 控制（debug/info/warn/error，默认 info），进程启动时读取一次（重启生效）；
 *   test 环境仅保留 error（单测断言不依赖日志输出；warn/info 刷屏干扰用例定位）。
 * - 兼容：签名保持 (msg, ...args) 与 console 语义一致，全部既有调用零改动。
 * - eval/ 下 CLI 脚本刻意保留 console（命令行输出即用户界面），不走本封装。
 */
import fs from 'node:fs';
import { getLogContext } from './asyncContext';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold(): number {
  const raw = (process.env.LOG_LEVEL || '').trim().toLowerCase();
  return raw in LEVELS ? LEVELS[raw as Level] : LEVELS.info;
}

type LogFormat = 'json' | 'pretty';

function resolveFormat(): LogFormat {
  const raw = (process.env.LOG_FORMAT || '').trim().toLowerCase();
  if (raw === 'json' || raw === 'pretty') return raw;
  return process.stdout.isTTY ? 'pretty' : 'json';
}

const threshold = resolveThreshold();
const format = resolveFormat();
const isTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';

function enabled(level: Level): boolean {
  if (LEVELS[level] < threshold) return false;
  if (isTest && LEVELS[level] < LEVELS.error) return false;
  return true;
}

// ---------- 结构化字段提取 ----------

/** 模块标签：现有约定 msg 以 [Module] 开头，提取为独立字段供按模块过滤/聚合 */
export function extractModuleTag(msg: string): string | undefined {
  const m = /^\[([A-Za-z][\w -]{0,31})\]/.exec(msg);
  return m ? m[1] : undefined;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
}

/** Error → 结构化对象（MySQL/Node 错误常见 code/errno 透传，栈限长防单行膨胀） */
export function serializeError(err: Error): Record<string, unknown> {
  const e = err as Error & { code?: unknown; errno?: unknown };
  const out: Record<string, unknown> = {
    name: err.name || 'Error',
    message: truncateText(err.message || err.name || '', 1024),
  };
  if (e.code !== undefined) out.code = String(e.code);
  if (e.errno !== undefined) out.errno = String(e.errno);
  if (err.stack) out.stack = truncateText(err.stack, 4096);
  return out;
}

/** 值安全化：保证可 JSON 序列化（循环引用/函数/Symbol 兜底为字符串），字符串与深层对象限长 */
export function safeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return truncateText(value, 1024);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return depth >= 3 ? `[Array(${value.length})]` : value.map((v) => safeValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 3) return '[Object]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = safeValue(v, depth + 1);
    return out;
  }
  return String(value);
}

/**
 * 构建结构化日志记录（导出供单测直接断言字段，不经 IO）。
 * 字段协议（自动运维智能体消费契约）：
 * ts(ISO) / level / msg / module? / requestId? / userId? / username? / taskId? / taskType? / err? / args?
 */
export function buildLogRecord(level: Level, msg: unknown, args: unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === 'string' ? truncateText(msg, 2000) : safeValue(msg),
  };
  if (typeof msg === 'string') {
    const module = extractModuleTag(msg);
    if (module) record.module = module;
  }
  const ctx = getLogContext();
  if (ctx) {
    if (ctx.requestId) record.requestId = ctx.requestId;
    if (ctx.userId !== undefined) record.userId = ctx.userId;
    if (ctx.username) record.username = ctx.username;
    if (ctx.taskId) record.taskId = ctx.taskId;
    if (ctx.taskType) record.taskType = ctx.taskType;
  }
  const errors = args.filter((a): a is Error => a instanceof Error);
  const rest = args.filter((a) => !(a instanceof Error));
  if (errors.length === 1) record.err = serializeError(errors[0]);
  else if (errors.length > 1) record.err = errors.map(serializeError);
  if (rest.length > 0) record.args = rest.map((v) => safeValue(v));
  return record;
}

// ---------- 输出 ----------

function writeLine(line: string, level: Level): void {
  // 对齐 console 语义：warn/error 走 stderr（fd 2），debug/info 走 stdout（fd 1）
  const fd = level === 'error' || level === 'warn' ? 2 : 1;
  try {
    fs.writeSync(fd, `${line}\n`);
  } catch {
    // 日志绝不反噬业务：fd 不可写（管道关闭等）时静默放弃本行
  }
}

function emitJson(level: Level, msg: unknown, args: unknown[]): void {
  try {
    writeLine(JSON.stringify(buildLogRecord(level, msg, args)), level);
  } catch {
    // 兜底：结构化构建/序列化意外失败时退化为纯文本行，保证消息不丢
    try {
      fs.writeSync(level === 'error' || level === 'warn' ? 2 : 1, `[${level}] ${String(msg)}\n`);
    } catch {
      /* 静默 */
    }
  }
}

function emitPretty(level: Level, msg: unknown, args: unknown[]): void {
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const fn =
    level === 'debug' ? console.debug
      : level === 'info' ? console.log
        : level === 'warn' ? console.warn
          : console.error;
  fn(prefix, msg, ...args);
}

function emit(level: Level, msg: unknown, args: unknown[]): void {
  (format === 'json' ? emitJson : emitPretty)(level, msg, args);
}

export const logger = {
  debug(msg: unknown, ...args: unknown[]): void {
    if (enabled('debug')) emit('debug', msg, args);
  },
  info(msg: unknown, ...args: unknown[]): void {
    if (enabled('info')) emit('info', msg, args);
  },
  warn(msg: unknown, ...args: unknown[]): void {
    if (enabled('warn')) emit('warn', msg, args);
  },
  error(msg: unknown, ...args: unknown[]): void {
    if (enabled('error')) emit('error', msg, args);
  },
};
