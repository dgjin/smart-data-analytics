/**
 * P2-3 进程内状态巡检（改进计划 2-3①）：扫描 server/ 与 server.ts 中模块级
 * `new Map()`/`new Set()`（空构造器 = 可变进程内存储），对照白名单做双向校验：
 *   - 白名单外新增 → 失败（强制显式登记并分类，防多实例部署状态失控）
 *   - 白名单条目已不存在 → 失败（强制清理陈旧登记）
 * 自动排除：
 *   - 函数/方法/构造器内的局部变量（请求级临时容器，非进程状态）
 *   - 带实参的字面量初始化（new Set([...]) 常量查找表，非可变存储）
 * 已知名限：模块级 `let` 数组/对象单例（如 llmClient 的 ollamaPool）与 IIFE 闭包状态
 * 不在本规则覆盖范围，由多实例部署指南显式登记、代码评审把关。
 * 运行：npm run state:check（CI quality 作业与 pre-push 均接入）。
 */
import ts from 'typescript';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 状态分类：redis-fallback=Redis 未配置时的单机内存回退；local-accel=本地加速层（正确性不依赖共享）；registry=代码级注册表；statestore-impl=StateStore 内存实现本体；cli-local=CLI 主入口守卫内的一次性状态（模块被 import 时不产生） */
export type StateCategory = 'redis-fallback' | 'local-accel' | 'registry' | 'statestore-impl' | 'cli-local';

export interface WhitelistEntry {
  /** 相对仓库根目录（POSIX 分隔符），如 server/queryCache.ts */
  file: string;
  /** 变量名；类属性为 ClassName.propName */
  name: string;
  category: StateCategory;
  /** 存在理由与多实例行为说明 */
  reason: string;
}

/**
 * 进程内状态白名单（2026-08-31 首次全量盘点）。
 * 新增模块级可变 Map/Set 时必须在此登记并选择分类，否则 CI 拦截。
 */
export const STATE_WHITELIST: WhitelistEntry[] = [
  // ---- redis-fallback：Redis 未配置时的单机内存回退（多实例部署必须配置 REDIS_URL）----
  { file: 'server/queryPlan.ts', name: 'store', category: 'redis-fallback', reason: '问数计划一次性存储（qp:*）的内存回退；多实例经 Redis GETDEL 共享' },
  { file: 'server/liveReport.ts', name: 'reportPlanStore', category: 'redis-fallback', reason: '报表计划存储（rqp:*）的内存回退；多实例经 Redis 共享' },
  { file: 'server/queryCache.ts', name: 'cache', category: 'redis-fallback', reason: '问数结果缓存（qc:*）的内存回退；多实例经 Redis 共享命中' },
  { file: 'server/queryCache.ts', name: 'semanticIndex', category: 'redis-fallback', reason: '语义缓存索引（qcidx:*）的内存回退；多实例经 Redis 共享' },
  { file: 'server/oidc.ts', name: 'stateStore', category: 'redis-fallback', reason: 'OIDC 登录 state（oidc:st:*）的内存回退；多实例经 Redis 共享防重放' },
  { file: 'server/rateLimiter.ts', name: 'requestLog', category: 'redis-fallback', reason: 'IP 限流窗口（rl:*）的内存回退；多实例经 Redis INCR 共享限额' },
  { file: 'server/userQueryLimit.ts', name: 'hits', category: 'redis-fallback', reason: '用户配额窗口（uql:*）的内存回退；多实例经 Redis 共享' },
  { file: 'server/userQueryLimit.ts', name: 'inflight', category: 'redis-fallback', reason: '用户并发槽（uqs:*）的内存回退；多实例经 Redis 分布式锁互斥' },
  // ---- local-accel：本地加速层（纯性能缓存，正确性不依赖跨实例共享）----
  { file: 'server/dataVersion.ts', name: 'versionCache', category: 'local-accel', reason: '数据版本指纹 10s 缓存，防多端轮询风暴；各实例独立探测无正确性问题' },
  { file: 'server/sqlExecutor.ts', name: 'dsPools', category: 'local-accel', reason: '数据源连接池：连接是进程资源不可跨实例共享，各实例独立建池' },
  { file: 'server/llmClient.ts', name: 'embedCache', category: 'local-accel', reason: 'embedding 文本向量缓存（带 TTL）；未命中仅多一次远程调用' },
  { file: 'server/schemaLinking.ts', name: 'tableEmbeddingCache', category: 'local-accel', reason: '表摘要向量缓存（key 含内容指纹，schema 编辑自动失效）；未命中仅多一次 embedding 调用' },
  { file: 'server/schemaLinking.ts', name: 'columnEmbeddingCache', category: 'local-accel', reason: '列摘要向量缓存（key 含内容指纹）；未命中仅多一次 embedding 调用' },
  // ---- registry：代码级注册表（启动时注册，无运行态跨请求语义）----
  { file: 'server/taskQueue.ts', name: 'handlers', category: 'registry', reason: '任务处理器注册表：进程启动时注册同一批 handler，各实例内容一致' },
  // ---- statestore-impl：StateStore 内存实现本体（接口层已支持 Redis 外置）----
  { file: 'server/stateStore.ts', name: 'MemoryStateStore.map', category: 'statestore-impl', reason: 'StateStore 内存实现的值存储；配置 REDIS_URL 后整类被 RedisStateStore 替代' },
  { file: 'server/stateStore.ts', name: 'MemoryStateStore.counters', category: 'statestore-impl', reason: 'StateStore 内存实现的窗口计数器；同上由 Redis 替代' },
  // ---- cli-local：CLI 主入口（isDirectRun/isMain 守卫）内的一次性状态，模块被 import 时不产生 ----
  { file: 'server/eval/checkEvalSet.ts', name: 'byCategory', category: 'cli-local', reason: '评测集门禁 CLI 主入口内的分类计数汇总，进程打印后即退出；作为库被 import 时不执行' },
];

export interface StateHit {
  file: string;
  name: string;
  line: number;
  kind: 'Map' | 'Set';
}

export interface CheckResult {
  hits: StateHit[];
  /** 白名单外的新增进程内状态 */
  violations: StateHit[];
  /** 白名单中已不存在于代码的陈旧条目 */
  stale: WhitelistEntry[];
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** 从 NewExpression 向上解析持有它的变量/属性名（不跨越函数边界） */
function resolveName(node: ts.Node, sf: ts.SourceFile): string {
  let cur: ts.Node | undefined = node;
  while (cur) {
    const p: ts.Node | undefined = cur.parent;
    if (!p || ts.isSourceFile(p) || isFunctionLike(p)) break;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) {
      const cls = p.parent;
      const clsName = ts.isClassLike(cls) && cls.name ? cls.name.text : '<anonymous>';
      return `${clsName}.${p.name.text}`;
    }
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
    cur = p;
  }
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `<expr@${line + 1}>`;
}

function scanFile(file: string, relFile: string, out: StateHit[]): void {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node, fnDepth: number): void => {
    const fn = isFunctionLike(node);
    if (fnDepth === 0 && !fn && ts.isNewExpression(node)) {
      const exprText = node.expression.getText(sf);
      if ((exprText === 'Map' || exprText === 'Set') && (!node.arguments || node.arguments.length === 0)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ file: relFile, name: resolveName(node, sf), line: line + 1, kind: exprText });
      }
    }
    node.forEachChild((c) => visit(c, fnDepth + (fn ? 1 : 0)));
  };
  visit(sf, 0);
}

/** 收集扫描范围：server/ 递归（排除 *.test.ts）+ server.ts */
export function collectServerFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
    }
  };
  const serverDir = join(rootDir, 'server');
  if (existsSync(serverDir)) walk(serverDir);
  const entryFile = join(rootDir, 'server.ts');
  if (existsSync(entryFile)) out.push(entryFile);
  return out.sort();
}

export function runCheck(rootDir: string, whitelist: WhitelistEntry[] = STATE_WHITELIST): CheckResult {
  const hits: StateHit[] = [];
  for (const file of collectServerFiles(rootDir)) {
    scanFile(file, relative(rootDir, file).split(sep).join('/'), hits);
  }
  const wlKeys = new Set(whitelist.map((w) => `${w.file}#${w.name}`));
  const hitKeys = new Set(hits.map((h) => `${h.file}#${h.name}`));
  return {
    hits,
    violations: hits.filter((h) => !wlKeys.has(`${h.file}#${h.name}`)),
    stale: whitelist.filter((w) => !hitKeys.has(`${w.file}#${w.name}`)),
  };
}

const CATEGORY_LABEL: Record<StateCategory, string> = {
  'redis-fallback': 'Redis 内存回退（多实例需 REDIS_URL）',
  'local-accel': '本地加速层（正确性不依赖共享）',
  registry: '代码级注册表',
  'statestore-impl': 'StateStore 内存实现',
  'cli-local': 'CLI 主入口一次性状态',
};

function main(): void {
  const rootDir = process.cwd();
  const result = runCheck(rootDir);
  const byKey = new Map(STATE_WHITELIST.map((w) => [`${w.file}#${w.name}`, w]));

  console.log(`[state:check] 扫描 server/ + server.ts，命中模块级可变存储 ${result.hits.length} 处（白名单 ${STATE_WHITELIST.length} 条）：`);
  for (const h of result.hits) {
    const w = byKey.get(`${h.file}#${h.name}`);
    const tag = w ? `${CATEGORY_LABEL[w.category]}` : '未登记';
    console.log(`  ${w ? '✓' : '✗'} ${h.file}:${h.line} ${h.name}（${h.kind}）— ${tag}`);
  }

  let failed = false;
  if (result.violations.length > 0) {
    failed = true;
    console.error('\n[state:check] 发现白名单外的新增进程内状态（请评估多实例影响并在 STATE_WHITELIST 登记，或改为外置存储）：');
    for (const v of result.violations) console.error(`  - ${v.file}:${v.line} ${v.name}（${v.kind}）`);
  }
  if (result.stale.length > 0) {
    failed = true;
    console.error('\n[state:check] 白名单存在已不存在的陈旧条目（请从 STATE_WHITELIST 移除）：');
    for (const s of result.stale) console.error(`  - ${s.file}#${s.name}`);
  }
  if (failed) process.exit(1);
  console.log('[state:check] 通过：全部进程内状态均已登记分类。');
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) main();
