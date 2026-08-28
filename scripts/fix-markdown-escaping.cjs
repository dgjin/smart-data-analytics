/**
 * P3-1 知识库编译修复：批量替换 Markdown 代码块为纯文本标记
 * 目的：消除 TypeScript 模板字符串中的反引号冲突导致的 TS1005/TS1127 错误
 */

const fs = require('fs');
const path = require('path');

// 配置
const TARGET_FILE = path.join(__dirname, '../server/seedDataResources.ts');
const REPLACEMENTS = [
  // 步骤 1: 替换 ```sql 代码块
  { regex: /```sql/g, replacement: '[SQL]' },
  { regex: /```/g, replacement: '[/SQL]' },
  
  // 步骤 2: 替换行内反引号 (保留 content:`开头的模板字符串)
  { 
    matchLine: true,
    predicate: (line) => !line.includes('content: `'),
    regex: /`([^`]+)`/g,
    replacement: '【$1】'
  }
];

console.log('🔧 开始修复 Markdown 代码块转义问题...\n');

try {
  console.log(`📄 目标文件：${TARGET_FILE}`);
  
  // 读取原文件
  let content = fs.readFileSync(TARGET_FILE, 'utf8');
  const originalContent = content;
  
  console.log(`📊 原始大小：${(content.length / 1024).toFixed(2)} KB\n`);
  
  // 执行替换
  console.log('🔄 执行文本替换...');
  let replacementCount = 0;
  
  for (const rule of REPLACEMENTS) {
    if (rule.matchLine) {
      // 按行处理，应用条件过滤
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (rule.predicate(lines[i])) {
          const before = lines[i];
          lines[i] = lines[i].replace(rule.regex, rule.replacement);
          if (before !== lines[i]) replacementCount++;
        }
      }
      content = lines.join('\n');
    } else {
      // 全局替换
      const matches = (content.match(rule.regex) || []).length;
      content = content.replace(rule.regex, rule.replacement);
      replacementCount += matches;
    }
    
    console.log(`   ✓ ${rule.regex.source} → ${rule.replacement}`);
  }
  
  // 写回文件
  fs.writeFileSync(TARGET_FILE, content, 'utf8');
  
  // 统计对比
  const newSize = content.length;
  const diff = newSize - originalContent.length;
  
  console.log(`\n✅ 替换完成！共修改 ${replacementCount} 处\n`);
  console.log(`📊 修改后大小：${(newSize / 1024).toFixed(2)} KB (变化：${diff > 0 ? '+' : ''}${diff} bytes)\n`);
  
  // 检查是否还有未处理的反引号
  const remainingBackticks = (content.match(/[^`]`[^`]+`/g) || []).filter(
    line => !line.startsWith('```') && !line.includes('content: `')
  );
  
  if (remainingBackticks.length > 0) {
    console.log(`⚠️  警告：检测到 ${remainingBackticks.length} 个潜在未处理的行内反引号:\n`);
    remainingBackticks.slice(0, 5).forEach(line => {
      console.log(`   ${line.trim()}`);
    });
    if (remainingBackticks.length > 5) {
      console.log(`   ... 还有 ${remainingBackticks.length - 5} 个`);
    }
    console.log('\n建议：手动检查这些位置是否需要进一步处理\n');
  } else {
    console.log('✅ 所有反引号已成功替换！\n');
  }
  
  // 下一步提示
  console.log('─────────────────────────────────────');
  console.log('🎯 下一步操作:\n');
  console.log('1. 验证 TypeScript 编译:\n   $ npm run lint\n\n');
  console.log('2. 如果编译通过，提交修复:\n   $ git add server/seedDataResources.ts\n   $ git commit -m "fix(P3-1): 替换 Markdown 代码块为纯文本标记消除编译错误"\n   $ git push\n\n');
  console.log('3. 测试功能完整性:\n   - 启动应用：npm start\n   - 尝试添加数据源（验证无错误）\n   - 查看知识库内容（确认格式可读）\n\n');
  console.log('─────────────────────────────────────\n');
  
  process.exit(0);
  
} catch (err) {
  console.error('\n❌ 执行失败:', err.message);
  console.error(err.stack);
  process.exit(1);
}
