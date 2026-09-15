/**
 * any 清零批次工具（质量优化 Stage 4）：catch 变量 any 收敛为 unknown 的机械化 codemod。
 *
 * 处理项（AST 级，避免误伤非 catch 变量）：
 * - `catch (v: any)` → `catch (v)`
 * - `v.message` / `v?.message` → `getErrorMessage(v)`（`v?.message || v` 整体合并）
 * - `v.code` / `v?.code` → `getErrorCode(v)`
 * - `v?.name === 'AbortError'` → `isAbortError(v)`（!== 取反）
 * - 自动补充 errorUtils 的 import（按文件路径选 server/src 侧辅助模块）
 *
 * 用法：npx tsx scripts/anyCatchCodemod.ts <文件列表...>
 */
import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const files = process.argv.slice(2).filter((f) => fs.existsSync(f));
if (files.length === 0) {
  console.error('用法: npx tsx scripts/anyCatchCodemod.ts <文件列表...>');
  process.exit(1);
}

let changedFiles = 0;
let totalEdits = 0;

for (const fp of files) {
  const src = fs.readFileSync(fp, 'utf8');
  const sf = ts.createSourceFile(
    fp,
    src,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(fp) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const edits: { start: number; end: number; text: string }[] = [];
  const need = { msg: false, code: false, abort: false };

  const isAny = (t?: ts.TypeNode): boolean => !!t && t.kind === ts.SyntaxKind.AnyKeyword;
  const isAcc = (n: ts.Node): n is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(n) || ts.isPropertyAccessChain(n);

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.variableDeclaration && isAny(node.variableDeclaration.type)) {
      const vd = node.variableDeclaration;
      const v = vd.name.getText(sf);
      // 1) 删除 `: any` 类型注解
      edits.push({ start: vd.name.getEnd(), end: vd.type!.getEnd(), text: '' });

      // 2) 块内属性访问收敛（仅限该 catch 变量）
      const walk = (n: ts.Node): void => {
        if (isAcc(n) && n.expression.getText(sf) === v) {
          const prop = n.name.getText(sf);
          const parent = n.parent;
          if (prop === 'message') {
            need.msg = true;
            // `v.message || v` → 整体合并为 getErrorMessage(v)
            if (
              ts.isBinaryExpression(parent) &&
              parent.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
              parent.left === n &&
              parent.right.getText(sf) === v
            ) {
              edits.push({ start: parent.getStart(sf), end: parent.getEnd(), text: `getErrorMessage(${v})` });
              return;
            }
            edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `getErrorMessage(${v})` });
            return;
          }
          if (prop === 'code') {
            need.code = true;
            edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `getErrorCode(${v})` });
            return;
          }
          if (prop === 'name') {
            // `v.name === 'AbortError'` / `!==`
            if (
              ts.isBinaryExpression(parent) &&
              (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
              ts.isStringLiteral(parent.right) &&
              parent.right.text === 'AbortError' &&
              parent.left === n
            ) {
              need.abort = true;
              const neg = parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
              edits.push({ start: parent.getStart(sf), end: parent.getEnd(), text: `${neg ? '!' : ''}isAbortError(${v})` });
              return;
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(node.block);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (edits.length > 0) {
    // 3) 补充 import（追加到最后一个 import 声明之后）
    const names: string[] = [];
    if (need.msg) names.push('getErrorMessage');
    if (need.code) names.push('getErrorCode');
    if (need.abort) names.push('isAbortError');
    if (names.length > 0 && !src.includes('errorUtils')) {
      const inServer = fp.includes('server/') || fp === 'server.ts' || fp.startsWith('server.ts');
      const target = inServer ? path.join(ROOT, 'server/infra/errorUtils.ts') : path.join(ROOT, 'src/utils/errorUtils.ts');
      let rel = path.relative(path.dirname(path.resolve(fp)), target).replace(/\.ts$/, '');
      if (!rel.startsWith('.')) rel = './' + rel;
      let lastImportEnd = -1;
      sf.forEachChild((n) => {
        if (ts.isImportDeclaration(n)) lastImportEnd = Math.max(lastImportEnd, n.getEnd());
      });
      const pos = lastImportEnd >= 0 ? lastImportEnd : 0;
      edits.push({ start: pos, end: pos, text: `\nimport { ${names.join(', ')} } from '${rel}';` });
    }

    // 从后往前应用，避免 span 漂移
    edits.sort((a, b) => b.start - a.start);
    let out = src;
    let lastStart = Infinity;
    for (const e of edits) {
      if (e.end > lastStart) continue; // 防重叠（父替换已覆盖子）
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
      lastStart = e.start;
    }
    fs.writeFileSync(fp, out);
    changedFiles++;
    totalEdits += edits.length;
    console.log(`[codemod] ${fp}: ${edits.length} 处`);
  }
}
console.log(`[codemod] 完成：${changedFiles} 个文件，共 ${totalEdits} 处编辑`);
