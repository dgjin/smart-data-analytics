/**
 * 精华版（4–5 分钟）男声旁白生成：解析 narration-short-male.md → edge-tts 合成 → ffprobe 量时长。
 * 与女声脚本 generate-tts-short.mjs 完全隔离：只读 narration-short-male.md，只写 audio-short-male/。
 *
 * 产出：
 *   scripts/demo-video/audio-short-male/s00.mp3 … s08.mp3
 *   scripts/demo-video/audio-short-male/s00.vtt …（VTT=1 时）
 *   scripts/demo-video/audio-short-male/durations.json
 *
 * 运行：VTT=1 node scripts/demo-video/generate-tts-short-male.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, 'audio-short-male');
mkdirSync(AUDIO_DIR, { recursive: true });

const EDGE_TTS = join(homedir(), 'Library/Python/3.12/bin/edge-tts');
const VOICE = 'zh-CN-YunxiNeural';
const RATE = '-4%';
const VTT = process.env.VTT === '1';
const PROXIES = ['http://127.0.0.1:7890', 'http://127.0.0.1:7891'];

// ── 1. 解析 narration-short-male.md（幕 ID 形如 s00 / s01 …）──
const md = readFileSync(join(__dirname, 'narration-short-male.md'), 'utf8');
const scenes = {};
let current = null;
for (const line of md.split('\n')) {
  const h = line.match(/^##\s*(s\d+[a-z]?)\s*·/);
  if (h) {
    current = h[1];
    scenes[current] = [];
    continue;
  }
  if (!current) continue;
  if (line.startsWith('>') || line.startsWith('#')) continue;
  if (line.trim()) scenes[current].push(line.trim());
}
const ids = Object.keys(scenes);
console.log('scenes found:', ids.join(', '));

// ── 多音字读音修正：仅作用于合成文本，VTT 生成后还原原文 ──
const TTS_FIXES = [
  ['行权限', '航权限'],
  ['一行', '一航'],
  ['万行', '万航'],
  ['行数', '航数'],
  ['行级', '航级'],
];
const applyFixes = (t) => TTS_FIXES.reduce((s, [from, to]) => s.split(from).join(to), t);
const revertFixes = (t) => TTS_FIXES.reduce((s, [from, to]) => s.split(to).join(from), t);

// edge-tts 经代理连微软 wss 偶发 ConnectionTimeout，自动重试并轮换代理端口
function ttsWithRetry(commonArgs, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    const proxy = PROXIES[(i - 1) % PROXIES.length];
    try {
      execFileSync(EDGE_TTS, ['--proxy', proxy, ...commonArgs], { stdio: ['ignore', 'ignore', 'pipe'] });
      return;
    } catch (e) {
      const msg = String((e && e.message) || e).split('\n').find((l) => /Error|Timeout/.test(l)) || '';
      console.log(`  edge-tts attempt ${i}/${attempts} (${proxy.split('//')[1]}) failed: ${msg.slice(0, 100)}`);
      if (i === attempts) throw e;
      execFileSync('sleep', ['3']);
    }
  }
}

// ── 2. 逐幕合成（SCENES=s02 可只重生成指定幕）──
const only = (process.env.SCENES || '').split(',').map((s) => s.trim()).filter(Boolean);
const list = only.length ? ids.filter((id) => only.includes(id)) : ids;
let durations = {};
try {
  durations = JSON.parse(readFileSync(join(AUDIO_DIR, 'durations.json'), 'utf8'));
} catch {}
for (const id of list) {
  const text = scenes[id].join('\n');
  const txtFile = join(AUDIO_DIR, `${id}.txt`);
  const mp3File = join(AUDIO_DIR, `${id}.mp3`);
  writeFileSync(txtFile, applyFixes(text), 'utf8');
  const args = ['--voice', VOICE, `--rate=${RATE}`, '--file', txtFile, '--write-media', mp3File];
  const vttFile = join(AUDIO_DIR, `${id}.vtt`);
  if (VTT) args.push('--write-subtitles', vttFile);
  ttsWithRetry(args);
  if (VTT && existsSync(vttFile)) {
    const raw = readFileSync(vttFile, 'utf8');
    const fixed = revertFixes(raw);
    if (fixed !== raw) writeFileSync(vttFile, fixed, 'utf8');
  }
  const probe = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', mp3File,
  ]).toString().trim();
  durations[id] = Math.round(parseFloat(probe) * 1000);
  rmSync(txtFile);
  console.log(`${id}: ${text.length} chars -> ${(durations[id] / 1000).toFixed(1)}s`);
}

writeFileSync(join(AUDIO_DIR, 'durations.json'), JSON.stringify(durations, null, 2));
const total = ids.reduce((a, b) => a + (durations[b] || 0), 0);
console.log(`TOTAL: ${(total / 1000 / 60).toFixed(2)} min (${(total / 1000).toFixed(1)}s)`);
console.log('TTS_DONE');
