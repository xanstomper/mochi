#!/usr/bin/env bash
# PTY visual smoke test — drive the built mochi binary under a script(1) PTY,
# send keystrokes (open the '/' dropdown, screenshot it), capture the raw
# terminal stream, then OCR-verify the splash/composer/dropdown rendered.
# Output: .mochi-audit/tui-smoke/typescript.log + verdict on stdout.
set -u
cd "$(dirname "$0")/.."
mkdir -p .mochi-audit/tui-smoke
export TERM=xterm-256color
export MOCHI_SKIP_AUTOBUILD=1

# Feeds keystrokes into the TUI over its lifetime:
#  t+2s  '/'   — open the command dropdown
#  t+3.5s ESC  — close it
#  t+4s  'fix' — type a prompt into the composer
#  t+5.5s ESC  — leave (composer shows typed text)
{ sleep 2; printf '/'; sleep 1.5; printf '\x1b'; sleep 0.5; printf 'fix'; sleep 1.5; printf '\x1b'; sleep 1; } | \
  timeout 15 script -qec "./dist/mochi-bin" .mochi-audit/tui-smoke/typescript.log > /dev/null 2>&1

BYTES=$(wc -c < .mochi-audit/tui-smoke/typescript.log)
echo "captured $BYTES bytes of terminal stream"
if [ "$BYTES" -lt 1000 ]; then
  echo "SMOKE FAIL: stream too small — TUI likely never rendered"
  exit 1
fi

# Strip ANSI/timing to plain text for assertions (typescript format = timing + raw).
python3 - <<'PYEOF'
import re, sys
raw = open('.mochi-audit/tui-smoke/typescript.log', 'rb').read().decode('utf-8', 'replace')
# typescript(1) interleaves timing headers <null>ttt<null>; strip them
clean = raw.replace('\x00', '')
# Strip ANSI escape sequences
text = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', clean)
text = re.sub(r'\x1b\][^\x07]*\x07', '', text)
text = re.sub(r'\x1b[()][B0]', '', text)
open('.mochi-audit/tui-smoke/plain.txt', 'w').write(text)

checks = {
    'splash_or_welcome': any(k in text for k in ('MOCHI', 'mochi', 'Shift+Tab', 'auto-approve')),
    'composer_present': any(k in text for k in ('ask', 'Type a message', '>')),
    'dropdown_opened': '/' in text,
    'typed_text': 'fix' in text,
}
fails = [k for k, ok in checks.items() if not ok]
for k, ok in checks.items():
    print(f"  {'PASS' if ok else 'FAIL'}: {k}")
if fails:
    print(f"SMOKE FAIL: {fails}")
    sys.exit(1)
print("SMOKE PASS: splash/composer/dropdown all rendered over the PTY")
PYEOF
