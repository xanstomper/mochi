#!/bin/sh
set -e
[ -f report.txt ] || { echo "report.txt missing"; exit 1; }
[ "$(sed -n '2p' report.txt)" = "READY" ] || { echo "line 2 must be READY"; exit 1; }
[ -n "$(sed -n '1p' report.txt)" ] || { echo "line 1 must be uname -s output"; exit 1; }
echo ok
