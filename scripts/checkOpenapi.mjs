#!/usr/bin/env node
/**
 * P2-11 OpenAPI 文档同步校验：
 * 解析 server.ts 的路由挂载与各路由文件的 router.<method> 定义，
 * 与 docs/openapi.json 的 paths 双向比对，防止 API 变更后文档漂移。
 * 用法：node scripts/checkOpenapi.mjs（CI / npm run docs:check）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverSrc = readFileSync(join(root, 'server.ts'), 'utf8');

// 1. import 别名 -> 路由文件路径
const importMap = {};
for (const m of serverSrc.matchAll(/import\s+(\w+)\s+from\s+'(\.\/server\/routes\/[\w-]+)';/g)) {
  importMap[m[1]] = `${m[2]}.ts`;
}

// 2. 前缀挂载（/api/datasource 为 legacy 别名，OpenAPI 只记 canonical /api/datasources）
const LEGACY_ALIASES = new Set(['/api/datasource']);
const prefixRoutes = [];
for (const m of serverSrc.matchAll(/app\.use\('(\/api\/[\w-]+)',\s*(\w+)\)/g)) {
  const [, prefix, alias] = m;
  if (LEGACY_ALIASES.has(prefix) || !importMap[alias]) continue;
  prefixRoutes.push({ prefix, file: importMap[alias] });
}

/** 归一化：:param -> {param}、去尾斜杠 */
function normalize(p) {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+$/, '') || '/';
}

// 3. 汇总代码端点集合
const codeEndpoints = new Set();
for (const m of serverSrc.matchAll(/app\.(get|post|put|delete|patch)\('(\/api\/[^']*)'/g)) {
  if (m[2].includes('*')) continue; // SPA fallback 非接口
  codeEndpoints.add(`${m[1].toUpperCase()} ${normalize(m[2])}`);
}
for (const { prefix, file } of prefixRoutes) {
  const src = readFileSync(join(root, file), 'utf8');
  for (const m of src.matchAll(/router\.(get|post|put|delete|patch)\('([^']*)'/g)) {
    const sub = m[2] === '/' ? '' : m[2];
    codeEndpoints.add(`${m[1].toUpperCase()} ${normalize(prefix + sub)}`);
  }
}

// 4. 汇总文档端点集合
const doc = JSON.parse(readFileSync(join(root, 'docs/openapi.json'), 'utf8'));
const docEndpoints = new Set();
for (const [p, item] of Object.entries(doc.paths || {})) {
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    if (item[method]) docEndpoints.add(`${method.toUpperCase()} ${normalize(p)}`);
  }
}

// 5. 双向比对
const missingInDoc = [...codeEndpoints].filter((e) => !docEndpoints.has(e)).sort();
const staleInDoc = [...docEndpoints].filter((e) => !codeEndpoints.has(e)).sort();

if (missingInDoc.length || staleInDoc.length) {
  if (missingInDoc.length) {
    console.error('文档缺失（代码有、docs/openapi.json 无）：');
    for (const e of missingInDoc) console.error(`  - ${e}`);
  }
  if (staleInDoc.length) {
    console.error('文档过期（docs 有、代码无，请删除或修正）：');
    for (const e of staleInDoc) console.error(`  - ${e}`);
  }
  console.error(`\n共 ${codeEndpoints.size} 个代码端点 / ${docEndpoints.size} 个文档端点，请同步 docs/openapi.json。`);
  process.exit(1);
}
console.log(`OpenAPI 同步校验通过：${docEndpoints.size} 个端点与路由定义一致`);
