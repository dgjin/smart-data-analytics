/**
 * 精华版男声重映射：把女声时间轴（audio-short/<幕>.vtt）映射到男声时间轴（audio-short-male/<幕>.vtt），
 * 生成 record-short-male.mjs 与 overlay-short-male/*.html；女声源文件与产物保持不变。
 *
 * 映射规则与 18 分钟版 make-male-version.mjs 一致（逐句锚定，分段线性、保序单调）。
 *
 * 前置：audio-short/ 与 audio-short-male/ 均含 9 幕 mp3/vtt/durations.json，且逐幕句数、文本一致。
 * 用法：node scripts/demo-video/make-male-version-short.mjs
 * 产物：record-short-male.mjs、overlay-short-male/*.html、diag-male/remap-report-short.txt
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENES = ['s00', 's01', 's02', 's03', 's04', 's05', 's06', 's07', 's08'];
const OVERLAY_SCENES = { 'intro.html': 's00', 'loop.html': 's07', 'outro.html': 's08' };
const OUT_OVERLAY = join(__dirname, 'overlay-short-male');
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
const fDur = JSON.parse(readFileSync(join(__dirname, 'audio-short', 'durations.json'), 'utf8'));
const mDur = JSON.parse(readFileSync(join(__dirname, 'audio-short-male', 'durations.json'), 'utf8'));
const report = [];
const mappers = {};

report.push('精华版男声时间轴映射报告（make-male-version-short.mjs 自动生成）', '');
report.push('== 1. 句级一致性校验 ==');
for (const id of SCENES) {
  if (!(id in fDur) || !(id in mDur)) throw new Error(`durations.json 缺少幕：${id}`);
  const fc = parseVtt(join(__dirname, 'audio-short', `${id}.vtt`));
  const mc = parseVtt(join(__dirname, 'audio-short-male', `${id}.vtt`));
  if (fc.length !== mc.length) throw new Error(`${id} 句数不一致：女声 ${fc.length} / 男声 ${mc.length}`);
  for (let i = 0; i < fc.length; i++) {
    if (normText(fc[i].text) !== normText(mc[i].text)) {
      throw new Error(`${id} 第 ${i + 1} 句文本不一致：\n  女：${fc[i].text}\n  男：${mc[i].text}`);
    }
  }
  mappers[id] = makeMapper(fc, mc);
  report.push(
    `${id}: 句数 ${fc.length}/${mc.length} 文本一致 | 女 ${(fDur[id] / 1000).toFixed(1)}s → 男 ${(mDur[id] / 1000).toFixed(1)}s`
  );
}

// ── 2. 转换 record-short.mjs ──
const srcRecord = readFileSync(join(__dirname, 'record-short.mjs'), 'utf8');
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

let outRecord = converted
  .replace(
    ' * 智能问数演示视频 · 精华版（4–5 分钟）分幕录制脚本（Playwright recordVideo）',
    [
      ' * 智能问数演示视频 · 精华版 · 男声版（Playwright recordVideo）',
      ' *',
      ' * 【自动生成】由 make-male-version-short.mjs 从 record-short.mjs 按 audio-short-male/ 句级时间轴映射而来。',
      ' *   - at() 已重映射到男声时间轴；行内注释中的秒数沿用女声原值，仅作语义参考；',
      ' *   - 产物写入 videos-short-male/，配音读取 audio-short-male/，overlay 读取 overlay-short-male/。',
      ' *   - 女声版 record-short.mjs / audio-short/ / videos-short/ / overlay-short/ 不受影响。',
    ].join('\n')
  )
  .replaceAll('scripts/demo-video/record-short.mjs', 'scripts/demo-video/record-short-male.mjs')
  .replace("join(__dirname, 'videos-short')", "join(__dirname, 'videos-short-male')")
  .replace("join(__dirname, 'audio-short', 'durations.json')", "join(__dirname, 'audio-short-male', 'durations.json')")
  .replaceAll("join(__dirname, 'overlay-short',", "join(__dirname, 'overlay-short-male',");

if (outRecord === srcRecord) throw new Error('record-short.mjs 未发生任何替换，检查匹配规则');
for (const must of ["'videos-short-male'", "'audio-short-male'", "'overlay-short-male'"]) {
  if (!outRecord.includes(must)) throw new Error(`record-short-male.mjs 缺少路径替换：${must}`);
}
writeFileSync(join(__dirname, 'record-short-male.mjs'), outRecord, 'utf8');

// ── 3. 转换 overlay ──
mkdirSync(OUT_OVERLAY, { recursive: true });
const overlayRows = [];
for (const [file, scene] of Object.entries(OVERLAY_SCENES)) {
  const src = readFileSync(join(__dirname, 'overlay-short', file), 'utf8');
  const map = mappers[scene];
  let n = 0;
  let maxD = 0;
  const out = src.replace(/--d:([0-9.]+)s/g, (_full, num) => {
    n++;
    const oldV = parseFloat(num);
    const nv = map(oldV);
    maxD = Math.max(maxD, nv);
    overlayRows.push({ file, scene, oldV, nv });
    return `--d:${fmt(nv)}s`;
  });
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
}

const fTotal = SCENES.reduce((a, b) => a + fDur[b], 0) / 1000;
const mTotal = SCENES.reduce((a, b) => a + mDur[b], 0) / 1000;
report.unshift(
  `女声总时长 ${(fTotal / 60).toFixed(2)} min（${fTotal.toFixed(1)}s）→ 男声 ${(mTotal / 60).toFixed(2)} min（${mTotal.toFixed(1)}s）`,
  ''
);

mkdirSync(DIAG, { recursive: true });
writeFileSync(join(DIAG, 'remap-report-short.txt'), report.join('\n') + '\n', 'utf8');

console.log(
  `[remap-short] ${SCENES.length} 幕句级校验通过；at ${atRows.length} 处、overlay ${overlayRows.length} 处已映射`
);
console.log(`[remap-short] 女声 ${(fTotal / 60).toFixed(2)} min → 男声 ${(mTotal / 60).toFixed(2)} min`);
console.log(`[remap-short] -> record-short-male.mjs, overlay-short-male/*.html, diag-male/remap-report-short.txt`);
console.log('REMAP_DONE');
