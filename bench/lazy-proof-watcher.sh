#!/usr/bin/env bash
# MCH-lazy 14 whole-task proof watcher: freeinference's key expired
# mid-session (401 Invalid or expired API key); the configured failovers are
# all dead (401/400/410). This watcher probes the primary every 5 minutes and,
# once chat works again, runs the FIXED fixture task set against TIP and BASE
# dists with identical accounting, then exits.
set -u
export PATH="/home/opc/.hermes/tools/node-26.12.1-linux-x64/bin:$PATH"
cd ~/mochi-lazy-everything

OUT_TIP=/tmp/lazyprobe/proof-tip.json
OUT_BASE=/tmp/lazyprobe/proof-base.json
DEADLINE=$(( $(date +%s) + 10800 ))   # give up after 3h
PROBE=0

probe_ok() {
  node --input-type=module -e "
import { readFileSync } from 'node:fs';
const c = JSON.parse(readFileSync('/home/opc/.config/mochi/config.json','utf8'));
try {
  const r = await fetch('https://freeinference.org/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.model.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3-flash', messages: [{role:'user',content:'say OK'}], max_tokens: 5 }),
  });
  console.log(r.status === 200 ? 'OK' : 'DOWN ' + r.status);
} catch { console.log('DOWN net'); }
" 2>/dev/null
}

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  PROBE=$((PROBE+1))
  R=$(probe_ok)
  echo "[$(date +%H:%M:%S)] probe $PROBE: $R"
  if [ "$R" = "OK" ]; then
    echo "[$(date +%H:%M:%S)] provider healthy — running whole-task proof (tip then base)"
    # Interleave per task for fairness: tip T1..T3, then base T1..T3, 2 runs each
    node bench/lazy-proof.mjs --bin ~/mochi-lazy-everything/dist/cli.js --label tip --runs 2 --out "$OUT_TIP"
    node bench/lazy-proof.mjs --bin /tmp/lazyproof-base/dist/cli.js --label base --runs 2 --out "$OUT_BASE"
    echo "[$(date +%H:%M:%S)] proof complete: $OUT_TIP $OUT_BASE"
    exit 0
  fi
  sleep 300
done
echo "[$(date +%H:%M:%S)] provider never healed within the window — writing PARTIAL marker"
echo "PROVIDER-DOWN-AT-END $(date -Iseconds)" > /tmp/lazyprobe/proof-provider-down.txt
exit 2
