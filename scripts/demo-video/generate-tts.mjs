/**
 * 旁白音频生成脚本：解析 narration.md 各幕文稿 → edge-tts 合成 mp3 → ffprobe 量时长。
 * 产出：
 *   scripts/demo-video/audio/m1.mp3 ... m9.mp3
 *   scripts/demo-video/audio/durations.json  （{ "m1": 41200, ... } 毫秒）
 *
 * 运行：node scripts/demo-video/generate-tts.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, 'audio');
mkdirSync(AUDIO_DIR, { recursive: true });

const EDGE_TTS = join(homedir(), 'Library/Python/3.12/bin/edge-tts');
const VOICE = 'zh-CN-XiaoxiaoNeural';
const RATE = '-4%';
// VTT=1 时同时输出字幕（词级时间戳，供录制脚本精确对齐画面与解说）
const VTT = process.env.VTT === '1';
// 微软 TTS 服务需经本机代理（iKuuu 客户端）；7890/7891 双端口回退（单端口偶发连接超时）
const PROXIES = ['http://127.0.0.1:7890', 'http://127.0.0.1:7891'];

// ── 1. 解析 narration.md ──
const md = readFileSync(join(__dirname, 'narration.md'), 'utf8');
const scenes = {}; // { m1: "正文..." }
let current = null;
for (const line of md.split('\n')) {
  const h = line.match(/^##\s*(m\d+)\s*·/);
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

// edge-tts 经代理连微软 wss 偶发 ConnectionTimeout，自动重试并轮换代理端口（最多 4 次，间隔 3s）
function ttsWithRetry(commonArgs, attempts = 4) {
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

// ── 2. 逐幕合成（SCENES=m2,m5 可只重生成指定幕，其余保留原时长） ──
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
  writeFileSync(txtFile, text, 'utf8');
  const args = ['--voice', VOICE, `--rate=${RATE}`, '--file', txtFile, '--write-media', mp3File];
  if (VTT) args.push('--write-subtitles', join(AUDIO_DIR, `${id}.vtt`));
  ttsWithRetry(args);
  const probe = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', mp3File,
  ]).toString().trim();
  durations[id] = Math.round(parseFloat(probe) * 1000);
  rmSync(txtFile);
  console.log(`${id}: ${text.length} chars -> ${(durations[id] / 1000).toFixed(1)}s`);
}

writeFileSync(join(AUDIO_DIR, 'durations.json'), JSON.stringify(durations, null, 2));
const total = Object.values(durations).reduce((a, b) => a + b, 0);
console.log(`TOTAL: ${(total / 1000 / 60).toFixed(2)} min`);
console.log('TTS_DONE');
