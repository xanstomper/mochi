#!/bin/sh
awk -F, 'NR>1 {s+=$1} END {print s}' data.csv > total.txt
