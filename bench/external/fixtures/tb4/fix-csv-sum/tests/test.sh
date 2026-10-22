#!/bin/sh
# Fixture verifier. Under the thin runner cwd is the task work dir; under
# Harbor the same script runs inside the task container.
set -e
[ -f total.txt ] || { echo "total.txt missing"; exit 1; }
grep -qx '42' total.txt || { echo "wrong total: $(cat total.txt)"; exit 1; }
echo ok
