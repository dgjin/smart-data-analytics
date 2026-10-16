#!/bin/bash
# 智能问数演示视频 · 音画合成脚本
# 1) 每幕：webm（录屏）+ mp3（旁白）→ mp4（音频尾部补静音至视频长）
# 2) 9 幕按序拼接 → 最终 mp4
#
# 用法：bash scripts/demo-video/compose-ffmpeg.sh
set -euo pipefail
cd "$(dirname "$0")"

CLIPS="clips"
FINAL_DIR="../../docs/演示视频"
mkdir -p "$CLIPS" "$FINAL_DIR"

SCENES=(m1 m2 m3 m4 m5 m6 m7 m8 m9)

for s in "${SCENES[@]}"; do
  echo "== compose $s =="
  ffmpeg -y -v error \
    -i "videos/$s.webm" -i "audio/$s.mp3" \
    -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
    -r 25 -c:a aac -b:a 192k -ar 44100 \
    -af apad -shortest \
    -movflags +faststart \
    "$CLIPS/$s.mp4"
done

: > "$CLIPS/list.txt"
for s in "${SCENES[@]}"; do
  echo "file '$(pwd)/$CLIPS/$s.mp4'" >> "$CLIPS/list.txt"
done

echo "== concat =="
OUT="$FINAL_DIR/智能问数数据分析系统-演示讲解.mp4"
ffmpeg -y -v error -f concat -safe 0 -i "$CLIPS/list.txt" -c copy -movflags +faststart "$OUT"

echo "== result =="
ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "$OUT"
echo "DONE: $OUT"
