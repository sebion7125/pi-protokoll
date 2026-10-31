#!/usr/bin/env bash
# End-to-end check with the real Pi CLI from node_modules and a stub model: installs this package
# into a throwaway agent directory, runs nine turns and expects compactions written by the
# extension. Needs `npm install` first. Leaves nothing behind.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI="$ROOT/node_modules/.bin/pi"
PORT="${E2E_PORT:-18080}"
TMP="$(mktemp -d)"
trap 'kill "$STUB" 2>/dev/null || true; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agent" "$TMP/work"

node "$ROOT/scripts/stub-model.mjs" "$PORT" "$TMP/requests.log" &
STUB=$!
sleep 1

cat >"$TMP/agent/models.json" <<JSON
{ "providers": { "stub": { "baseUrl": "http://127.0.0.1:$PORT/v1", "api": "openai-completions", "apiKey": "x",
  "models": [ { "id": "m", "contextWindow": 32000 } ] } } }
JSON
cat >"$TMP/agent/settings.json" <<JSON
{ "packages": ["$ROOT"], "compaction": { "enabled": true, "reserveTokens": 22000, "keepRecentTokens": 1500 } }
JSON
echo '{ "detailMaxTokens": 1200, "statusMaxTokens": 900, "keepRecentTurns": 1, "userMessageMaxChars": 400 }' >"$TMP/agent/protokoll.json"

run() {
	(cd "$TMP/work" && env PI_OFFLINE=1 PI_TELEMETRY=0 NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 \
		PI_CODING_AGENT_DIR="$TMP/agent" timeout 120 "$PI" --print --model stub/m "$@" </dev/null >/dev/null)
}
filler="$(printf 'lorem ipsum dolor %.0s' {1..500})"
run "question 1 $filler"
for i in $(seq 2 8); do run --continue "question $i $filler"; done
# switching inside a session: the withdrawal goes in as a message, the prompt keeps its text
run --continue "/protokoll off"
run --continue "question 9 $filler"

session="$(ls -t "$TMP"/agent/sessions/*/*.jsonl | head -1)"
grep -q '"customType":"protokoll"' "$session" || { echo "FAIL: no protocol entries" >&2; exit 1; }
grep -q '"customType":"protokoll-compact"' "$session" || { echo "FAIL: no compaction status entry" >&2; exit 1; }
grep -q '"durationMs":[0-9]' "$session" || { echo "FAIL: compaction status without a duration" >&2; exit 1; }
own="$(grep -c '"protokoll":true' "$session" || true)"
[[ "$own" -ge 1 ]] || { echo "FAIL: no compaction written by the extension" >&2; exit 1; }
grep -q "session_protocol" "$TMP/requests.log" || { echo "FAIL: system prompt section missing" >&2; exit 1; }
grep -q "how full your context is" "$TMP/requests.log" || { echo "FAIL: note about session length missing" >&2; exit 1; }
grep -q '"customType":"protokoll-switch"' "$session" || { echo "FAIL: no message about the switch" >&2; exit 1; }
# the last chat request still carries the section in its prompt, and the withdrawal in its transcript
node -e '
	const fs = require("node:fs");
	const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const chats = lines.filter((l) => (l.tools || []).some((t) => t.function && t.function.name === "protocol_turn"));
	const last = chats[chats.length - 1];
	const head = last && last.messages[0] && last.messages[0].role === "system" ? last.messages[0].content : "";
	const kept = head.includes("<session_protocol>");
	const delivered = JSON.stringify(last).includes("pi-protokoll disabled");
	if (!kept || !delivered) {
		console.error(`FAIL: soft off changed the prompt (section kept: ${kept}) or the withdrawal never reached the model (${delivered})`);
		process.exit(1);
	}
' "$TMP/requests.log" || exit 1
echo "OK: Pi $("$PI" --version) – $own compaction(s) written by the extension, switch note delivered without touching the prompt"
