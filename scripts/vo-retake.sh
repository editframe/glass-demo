#!/usr/bin/env bash
# Generates N takes of the given line ids, scores each with vo-check.mjs,
# and installs the highest-scoring clean take into src/assets/vo.
#
#   scripts/vo-retake.sh 3 hook-1 hook-2
set -euo pipefail
cd "$(dirname "$0")/.."
takes=$1; shift
work=$(mktemp -d /tmp/vo-takes.XXXX)

for n in $(seq 1 "$takes"); do
  node scripts/tts.mjs --out "$work/t$n" "$@" >/dev/null &
done
wait

for id in "$@"; do
  best=""; best_score=-1
  for n in $(seq 1 "$takes"); do
    f="$work/t$n/$id.wav"
    [ -f "$f" ] || continue
    result=$(VO_CHECK_MODEL=gemini-3.8-flash node scripts/vo-check.mjs "$f" | sed 1,2d)
    score=$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.extra_speech||j.artifacts.length?Math.min(j.score,5):j.score)' "$result")
    echo "$id take $n: score $score :: $(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.transcript,"|",j.artifacts.join("; "))' "$result")"
    if awk "BEGIN{exit !($score > $best_score)}"; then best=$f; best_score=$score; fi
  done
  cp "$best" "src/assets/vo/$id.wav"
  echo "$id -> $best ($best_score)"
done

node -e '
const fs=require("fs"),{execFileSync}=require("child_process");
const m=JSON.parse(fs.readFileSync("src/vo-manifest.json","utf8"));
const s=JSON.parse(fs.readFileSync("scripts/vo-script.json","utf8"));
for (const id of process.argv.slice(1)) {
  const d=Number(execFileSync("ffprobe",["-v","error","-show_entries","format=duration","-of","csv=p=0",`src/assets/vo/${id}.wav`]).toString());
  m[id]={text:s.lines.find(l=>l.id===id).text,duration:Number(d.toFixed(3))};
}
fs.writeFileSync("src/vo-manifest.json",JSON.stringify(m,null,2)+"\n");
' "$@"
