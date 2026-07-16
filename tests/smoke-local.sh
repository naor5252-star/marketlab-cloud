#!/bin/sh
set -eu
BASE="${BASE:-http://127.0.0.1:8787}"
COOKIE="${TMPDIR:-/tmp}/marketlab-cookie.txt"
rm -f "$COOKIE"
curl -fsS "$BASE/healthz" | grep -q '"status":"ok"'
curl -fsS "$BASE/" | grep -q 'MarketLab'
curl -fsS -c "$COOKIE" -X POST -d 'password=test-password' "$BASE/auth/login" -o /dev/null
curl -fsS -b "$COOKIE" "$BASE/api/health" | grep -q '"backend":"Cloudflare Worker + D1"'
curl -fsS -b "$COOKIE" -H 'Content-Type: application/json' -d '{"version":12,"symbol":"KLAC","trades":[]}' "$BASE/api/state" | grep -q '"saved":true'
curl -fsS -b "$COOKIE" -H 'Content-Type: application/json' -d '{"id":"smoke-1","time":"2026-07-16T08:00:00Z","symbol":"KLAC","side":"buy","qty":1,"price":231.52,"fee":0}' "$BASE/api/trades" | grep -q '"saved":true'
curl -fsS -b "$COOKIE" "$BASE/api/trades" | grep -q 'smoke-1'
curl -fsS -b "$COOKIE" "$BASE/api/export" | grep -q 'marketlab-cloud-backup'
echo "Cloudflare Worker local smoke test passed"
