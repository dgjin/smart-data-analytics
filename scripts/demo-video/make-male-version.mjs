/**
 * 男声版生成器：把女声时间轴（audio/<幕>.vtt）映射到男声时间轴（audio-male/<幕>.vtt），
 * 生成 record-male.mjs 与 overlay-male/*.html，女声所有源文件与产物保持不变。
 *
 * 映射规则（逐句锚定）：
 *   - 时间点落在某句内：男声同句句首 + 同比例偏移（保持句子内部的语义相对位置）；
 *   - 落在两句间隙：男声对应间隙内同比例插值；
 *   - 落在末句之后：男声末句末尾顺延；
 *   - 落在首句之前：按首句起点等比缩放。
 *
 * 前置：audio/ 与 audio-male/ 均含 15 幕 mp3/vtt/durations.json，且逐幕句数与文本一致。
 * 用法：node scripts/demo-video/make-male-version.mjs
 * 产物：record-male.mjs、overlay-male/*.html、diag-male/remap-report.txt
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENES = ['m00', 'm0', 'm01', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm8b', 'm8c', 'm9', 'm10'];
// overlay 文件 → 所属幕（与 record.mjs 中的加载位置一致）
const OVERLAY_SCENES = { 'intro.html': 'm00', 'loop.html': 'm8b', 'memory.html': 'm8c', 'outro.html': 'm10' };
const OUT_OVERLAY = join(__dirname, 'overlay-male');
const DIAG = join(__dirname, 'diag-male');

const fmt = (v) => String(Math.round(v * 100) / 100);
const normText = (t) => String(t).replace(/\s+/g, '');

// ── VTT 解析（edge-tts 输出为 SRT 风格：编号 + 时间行 + 文本）──
function parseVtt(file) {
  const raw = readFileSync(file, 'utf8').replace(/\r/g, '');
  const cues = [];
  for (const block of raw.split(/\n{2,}/)) {
    const lines = block.split('\n').filter(Boolean);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const m = lines[ti].match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!m) continue;
    const sec = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +ms / 1000;
    cues.push({
      start: sec(m[1], m[2], m[3], m[4]),
      end: sec(m[5], m[6], m[7], m[8]),
      text: lines.slice(ti + 1).join(' ').trim(),
    });
  }
  return cues;
}

// ── 映射器：分段线性、端点连续，保序且单调 ──
function makeMapper(fc, mc) {
  const last = fc.length - 1;
  return (t) => {
    if (t <= fc[0].start) return fc[0].start > 0 ? (t / fc[0].start) * mc[0].start : t;
    for (let i = 0; i < fc.length; i++) {
      const f = fc[i];
      const m = mc[i];
      if (t <= f.end) {
        const fd = Math.max(f.end - f.start, 0.001);
        const ratio = Math.min(Math.max((t - f.start) / fd, 0), 1);
        return m.start + ratio * (m.end - m.start);
      }
      const next = fc[i + 1];
      if (next && t < next.start) {
        const fg = next.start - f.end;
        const mg = mc[i + 1].start - m.end;
        const ratio = fg > 0 ? (t - f.end) / fg : 0;
        return m.end + ratio * mg;
      }
    }
    return mc[last].end + (t - fc[last].end);
  };
}

// ── 1. 解析并校验男女句级时间轴 ──
const fDur = JSON.parse(readFileSync(join(__dirname, 'audio', 'durations.json'), 'utf8'));
const mDur = JSON.parse(readFileSync(join(__dirname, 'audio-male', 'durations.json'), 'utf8'));
const report = [];
const mappers = {};

report.push('男声时间轴映射报告（make-male-version.mjs 自动生成）', '');
report.push('== 1. 句级一致性校验 ==');
for (const id of SCENES) {
  if (!(id in fDur) || !(id in mDur)) throw new Error(`durations.json 缺少幕：${id}`);
  const fc = parseVtt(join(__dirname, 'audio', `${id}.vtt`));
  const mc = parseVtt(join(__dirname, 'audio-male', `${id}.vtt`));
  if (fc.length !== mc.length) throw new Error(`${id} 句数不一致：女声 ${fc.length} / 男声 ${mc.length}`);
  for (let i = 0; i < fc.length; i++) {
    if (normText(fc[i].text) !== normText(mc[i].text)) {
      // 唯一预期差异：男声片头把全片时长 16 分钟改为 15 分钟（其余文字相同）
      const allowed =
        id === 'm00' &&
        i === 1 &&
        normText(fc[i].text).replace(/\d+/g, '#') === normText(mc[i].text).replace(/\d+/g, '#');
      if (!allowed) {
        throw new Error(`${id} 第 ${i + 1} 句文本不一致：\n  女：${fc[i].text}\n  男：${mc[i].text}`);
      }
      report.push(`m00 第 ${i + 1} 句（预期差异）：${fc[i].text} → ${mc[i].text}`);
    }
  }
  mappers[id] = makeMapper(fc, mc);
  report.push(
    `${id}: 句数 ${fc.length}/${mc.length} 文本一致 | 女 ${(fDur[id] / 1000).toFixed(1)}s → 男 ${(mDur[id] / 1000).toFixed(1)}s`
  );
}

// ── 2. 转换 record.mjs ──
const srcRecord = readFileSync(join(__dirname, 'record.mjs'), 'utf8');
let cur = null;
const atRows = [];
const converted = srcRecord
  .split('\n')
  .map((line) => {
    const sm = line.match(/if \(want\('(\w+)'\)\) await scene\('(\w+)'/);
    if (sm) cur = sm[1];
    if (!cur) return line;
    return line.replace(/await at\(([0-9.]+)\)/g, (_full, num) => {
      const oldV = parseFloat(num);
      const nv = mappers[cur](oldV);
      atRows.push({ scene: cur, oldV, nv });
      return `await at(${fmt(nv)})`;
    });
  })
  .join('\n');

// 路径与标题：只改男声版自己的输入输出目录，不触碰女声
let outRecord = converted
  .replace(
    ' * 智能问数演示视频 · 分幕录制脚本 v2（Playwright recordVideo）',
    [
      ' * 智能问数演示视频 · 分幕录制脚本 v2 · 男声版（Playwright recordVideo）',
      ' *',
      ' * 【自动生成】由 make-male-version.mjs 从 record.mjs 按 audio-male/ 句级时间轴映射而来。',
      ' *   - at() 已重映射到男声时间轴；行内注释中的秒数沿用女声原值，仅作语义参考；',
      ' *   - 产物写入 videos-male/，配音读取 audio-male/，overlay 读取 overlay-male/。',
      ' *   - 女声版 record.mjs / audio/ / videos/ / overlay/ 不受影响。',
    ].join('\n')
  )
  .replaceAll('scripts/demo-video/record.mjs', 'scripts/demo-video/record-male.mjs')
  .replace("join(__dirname, 'videos')", "join(__dirname, 'videos-male')")
  .replace("join(__dirname, 'audio', 'durations.json')", "join(__dirname, 'audio-male', 'durations.json')")
  .replaceAll("join(__dirname, 'overlay',", "join(__dirname, 'overlay-male',");

if (outRecord === srcRecord) throw new Error('record.mjs 未发生任何替换，检查匹配规则');
for (const must of ["'videos-male'", "'audio-male'", "'overlay-male'"]) {
  if (!outRecord.includes(must)) throw new Error(`record-male.mjs 缺少路径替换：${must}`);
}
writeFileSync(join(__dirname, 'record-male.mjs'), outRecord, 'utf8');

// ── 3. 转换 overlay ──
mkdirSync(OUT_OVERLAY, { recursive: true });
const overlayRows = [];
for (const [file, scene] of Object.entries(OVERLAY_SCENES)) {
  const src = readFileSync(join(__dirname, 'overlay', file), 'utf8');
  const map = mappers[scene];
  let n = 0;
  let maxD = 0;
  let out = src.replace(/--d:([0-9.]+)s/g, (_full, num) => {
    n++;
    const oldV = parseFloat(num);
    const nv = map(oldV);
    maxD = Math.max(maxD, nv);
    overlayRows.push({ file, scene, oldV, nv });
    return `--d:${fmt(nv)}s`;
  });
  // 片头片尾的整片时长提示：男声版 ≈ 14.9 分钟，文案改为 15 分钟
  if (file === 'intro.html') {
    const before = out;
    out = out.replace('全片约 <b>16 分钟</b>', '全片约 <b>15 分钟</b>');
    if (out === before) report.push('警告：intro.html 未找到「全片约 16 分钟」文案，请人工核对');
  }
  if (!n) throw new Error(`${file} 未匹配到任何 --d 值`);
  if (maxD > mDur[scene] / 1000 + 0.5) {
    report.push(`警告：${file} 最大 --d=${fmt(maxD)}s 超出 ${scene} 男声时长 ${(mDur[scene] / 1000).toFixed(1)}s`);
  }
  writeFileSync(join(OUT_OVERLAY, file), out, 'utf8');
  report.push(`overlay ${file} → ${scene}：${n} 个 --d 已映射（最大 ${fmt(maxD)}s / 男声 ${(mDur[scene] / 1000).toFixed(1)}s）`);
}

// ── 4. 校验：单调性与超时 ──
report.push('', '== 2. at() 映射明细 ==');
const byScene = {};
for (const r of atRows) (byScene[r.scene] ||= []).push(r);
for (const [scene, rows] of Object.entries(byScene)) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].nv < rows[i - 1].nv - 0.01) {
      throw new Error(`${scene} 映射后 at 非单调：${rows[i - 1].nv} → ${rows[i].nv}`);
    }
  }
  const maxAt = rows[rows.length - 1].nv;
  const durS = mDur[scene] / 1000;
  report.push(`${scene}: ${rows.length} 个 at，最大 ${fmt(maxAt)}s / 男声时长 ${durS.toFixed(1)}s`);
  if (maxAt > durS) report.push(`  警告：最大 at 超出本幕男声时长，末段动作会被裁尾`);
  report.push(
    '  ' + rows.map((r) => `${fmt(r.oldV)}→${fmt(r.nv)}`).join('  ')
  );
}
report.push('', '== 3. overlay --d 映射明细 ==');
for (const [file, rows] of Object.entries(
  overlayRows.reduce((acc, r) => ((acc[r.file] ||= []).push(r), acc), {})
)) {
  report.push(`${file}（${rows[0].scene}）:`);
  report.push('  ' + rows.map((r) => `${fmt(r.oldV)}→${fmt(r.nv)}`).join('  '));
}

const fTotal = Object.values(fDur).reduce((a, b) => a + b, 0) / 1000;
const mTotal = Object.values(mDur).reduce((a, b) => a + b, 0) / 1000;
report.unshift(
  `女声总时长 ${(fTotal / 60).toFixed(2)} min（${fTotal.toFixed(1)}s）→ 男声 ${(mTotal / 60).toFixed(2)} min（${mTotal.toFixed(1)}s）`,
  ''
);

mkdirSync(DIAG, { recursive: true });
writeFileSync(join(DIAG, 'remap-report.txt'), report.join('\n') + '\n', 'utf8');

console.log(
  `[remap] 15 幕句级校验通过；at ${atRows.length} 处、overlay ${overlayRows.length} 处已映射`
);
console.log(`[remap] 女声 ${(fTotal / 60).toFixed(2)} min → 男声 ${(mTotal / 60).toFixed(2)} min`);
console.log(`[remap] -> record-male.mjs, overlay-male/*.html, diag-male/remap-report.txt`);
console.log('REMAP_DONE');
