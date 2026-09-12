#!/usr/bin/env bash
# record-run.sh <model-id> <input-slug> <max-steps> <out.json> <recording-id> <title> [hardware] [notes]
#
# Records a real run for site/src/data/recordings: drives the built site in a
# headless Chrome that can see the GPU (see README, "Trying a real model from
# the command line"), loads the model, runs up to max-steps instructions or
# until the machine halts, then saves what the page's record() returns. The
# preview server must already be up on port 4321 and the browser session
# named by AGENT_BROWSER_SESSION already opened with the WebGPU flags. Knobs
# are whatever the page defaults to; change them in the page before running
# if a recording needs others. Nothing is edited on the way through.
set -euo pipefail
MODEL=$1; INPUT=$2; MAX=$3; OUT=$4; ID=$5; TITLE=$6; HARDWARE=${7:-unknown hardware}; NOTES=${8:-}
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-gpu}
ab() { agent-browser "$@"; }
# BROWSER_ARGS lets a fresh session start with the WebGPU flags (see README)
ab ${BROWSER_ARGS:+--args "$BROWSER_ARGS"} open http://localhost:4321/llmcpu/ >/dev/null
ok=false
for i in $(seq 1 30); do
  sleep 2
  ok=$(ab eval "!!document.querySelector('#model option[value=\"$MODEL\"]') && !!document.querySelector('#program option[value=\"$INPUT\"]')")
  [[ "$ok" == "true" ]] && break
done
[[ "$ok" == "true" ]] || { echo "options never appeared"; exit 1; }
ab select "#program" "$INPUT" >/dev/null
sleep 2
echo "input: $(ab eval "document.querySelector('#status').textContent")"
ab select "#model" "$MODEL" >/dev/null
sleep 1
ab click "#load-model" >/dev/null
sleep 3
echo "loading: $(ab eval "document.querySelector('#model-note').textContent")"
for i in $(seq 1 120); do
  sleep 5
  st=$(ab eval "document.querySelector('#status').textContent")
  [[ "$st" == *"model ready"* ]] && break
  [[ "$st" == *"failed"* || "$st" == *"Could not"* ]] && { echo "load failed: $st"; exit 1; }
done
echo "loaded $MODEL at $(date +%T)"
ab click "#run" >/dev/null
start=$(date +%s)
while true; do
  sleep 15
  n=$(ab eval "window.llmcpu.session.cpu ? window.llmcpu.session.cpu.steps.length : -1")
  halted=$(ab eval "window.llmcpu.session.model.halted !== null")
  st=$(ab eval "document.querySelector('#status').textContent")
  echo "$(date +%T) steps=$n halted=$halted status=$st"
  if [[ "$n" -ge "$MAX" || "$halted" == "true" || "$st" == *"failed"* ]]; then break; fi
  if (( $(date +%s) - start > 5400 )); then echo "timeout"; break; fi
done
ab click "#run" >/dev/null 2>&1 || true   # pause if still running
sleep 20
ab eval "window.llmcpu.record({id: '$ID', title: '$TITLE', model: window.llmcpu.backend.id, modelLabel: '$MODEL'.replace('-', ' '), date: new Date().toISOString().slice(0,10), hardware: '$HARDWARE', notes: '$NOTES'})" > "$OUT.raw"
python3 - "$OUT" <<'PY'
import json, sys
raw = open(sys.argv[1] + ".raw").read()
rec = json.loads(json.loads(raw))
json.dump(rec, open(sys.argv[1], "w"), separators=(",", ":"))
print("saved", sys.argv[1], "steps", rec["meta"]["steps"], "design", (rec["design"] or {}).get("design"))
PY
