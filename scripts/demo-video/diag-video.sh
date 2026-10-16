#!/bin/bash
set -u
cd "$(dirname "$0")"
mkdir -p diag
echo "== health =="
curl -s -o /dev/null -w "server http=%{http_code}\n" --max-time 5 http://127.0.0.1:3000 || echo "server down"
redis-cli ping 2>/dev/null || echo "redis down"
echo "== videos =="
ls -lh videos/ | awk '{print $5, $9}'
for s in m4 m5; do
  echo "== $s format =="
  ffprobe -v error -show_entries format=duration,size,bit_rate -of default=noprint_wrappers=1 "videos/$s.webm"
  echo "== $s frames =="
  ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames,avg_frame_rate -of default=noprint_wrappers=1 "videos/$s.webm"
  echo "== $s gaps>3s =="
  ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "videos/$s.webm" | awk -F, 'NR==1{first=$1;prev=$1;next}{d=$1-prev; if(d>3) printf "gap %8.1f -> %8.1f  (%.1fs)\n", prev, $1, d; prev=$1} END{printf "first=%.1f last=%.1f\n", first, prev}'
done
echo "== frames m4 =="
for t in 15 28 35 45 70 120 240 460; do ffmpeg -y -v error -ss $t -i videos/m4.webm -frames:v 1 diag/m4-t${t}.png; done
echo "== frames m5 =="
for t in 15 30 45 55 70 120 240 400; do ffmpeg -y -v error -ss $t -i videos/m5.webm -frames:v 1 diag/m5-t${t}.png; done
ls diag/
echo DONE
