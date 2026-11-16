#!/usr/bin/env node
/**
 * 精华版（4–5 分钟）音画合成：每幕 webm（无声）+ mp3（旁白）→ mp4，再拼接为最终成片。
 * 策略：音频为主时间轴 T = 音频时长；视频不足 T 用 tpad 冻结末帧补齐，超长裁尾。
 *
 * 用法：
 *   node scripts/demo-video/compose-short.mjs            # 女声（audio-short/ + videos-short/）
 *   VOICE=male node scripts/demo-video/compose-short.mjs # 男声（audio-short-male/ + videos-short-male/）
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENES = ['s00', 's01', 's02', 's03', 's04', 's05', 's06', 's07', 's08'];
const MALE = process.env.VOICE === 'male';
const AUDIO_DIR = join(__dirname, MALE ? 'audio-short-male' : 'audio-short');
const VIDEO_DIR = join(__dirname, MALE ? 'videos-short-male' : 'videos-short');
const OUT = join(__dirname, MALE ? 'out-short-male' : 'out-short');
const FINAL = join(__dirname, MALE ? '智能问数数据分析系统-演示讲解-精华版-男声.mp4' : '智能问数数据分析系统-演示讲解-精华版.mp4');
mkdirSync(OUT, { recursive: true });

const probe = (f) =>
  parseFloat(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', f,
    ]).toString().trim()
  );

const run = (args, cwd) => execFileSync('ffmpeg', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });

let total = 0;
for (const s of SCENES) {
  const v = join(VIDEO_DIR, `${s}.webm`);
  const a = join(AUDIO_DIR, `${s}.mp3`);
  if (!existsSync(v) || !existsSync(a)) throw new Error(`missing source: ${s} (${MALE ? 'male' : 'female'})`);
  const vd = probe(v);
  const ad = probe(a);
  const T = ad; // 音频为主时间轴
  const out = join(OUT, `${s}.mp4`);
  run([
    '-y', '-i', v, '-i', a,
    '-filter_complex', '[0:v]tpad=stop_mode=clone:stop_duration=6,fps=25[v]',
    '-map', '[v]', '-map', '1:a', '-t', T.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart', out,
  ]);
  const od = probe(out);
  console.log(
    `[compose] ${s}: video=${vd.toFixed(1)}s audio=${ad.toFixed(1)}s -> mp4=${od.toFixed(1)}s${vd < ad ? ' (tpad 补齐)' : ''}`
  );
  total += od;
}

writeFileSync(join(OUT, 'concat.txt'), SCENES.map((s) => `file '${s}.mp4'`).join('\n') + '\n');
run(['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', FINAL], OUT);
const fd = probe(FINAL);
console.log(`[compose] FINAL -> ${FINAL}`);
console.log(`[compose] 总时长 ${(fd / 60).toFixed(2)} min (${fd.toFixed(1)}s)，分幕合计 ${(total / 60).toFixed(2)} min`);
console.log('COMPOSE_DONE');
