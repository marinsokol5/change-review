#!/usr/bin/env bash
# Manual end-to-end test for the PreToolUse hook flow (run: bash test-hook.sh).
set -u
TH="$TMPDIR/agent-change-reviewer-test-home"; REPO="$TMPDIR/agent-change-reviewer-test-repo"
CLI="node $(cd "$(dirname "$0")" && pwd)/dist/cli.js"
export AGENT_CHANGE_REVIEWER_NO_OPEN=1

hook_input() { # $1=tool $2=tool_input-json
  printf '{"session_id":"cs1","cwd":"%s","tool_name":"%s","tool_input":%s}' "$REPO" "$1" "$2"
}

find_port() { # newest live server.json
  for _ in $(seq 1 60); do
    SJ=$(ls -t "$TH"/.agent-change-reviewer/sessions/*/server.json 2>/dev/null | head -1)
    if [ -n "${SJ:-}" ]; then node -pe "JSON.parse(require('fs').readFileSync('$SJ','utf8')).port"; return; fi
    sleep 0.25
  done
  echo ""
}

case "${1:-}" in
  setup)
    rm -rf "$TH" "$REPO"; mkdir -p "$TH" "$REPO"
    printf 'line one\nline two\nline three\n' > "$REPO/app.ts"
    HOME="$TH" $CLI hook on
    ;;
  edit-accept)
    hook_input Edit '{"file_path":"'"$REPO"'/app.ts","old_string":"line two","new_string":"line 2!"}' \
      | HOME="$TH" $CLI hook-run > "$TMPDIR/hook-out.json" 2> "$TMPDIR/hook-err.txt" &
    PID=$!
    PORT=$(find_port)
    echo "port=$PORT"
    echo "--- GET / title:";        curl -s "http://127.0.0.1:$PORT/" | grep -o '<title>[^<]*</title>'
    echo "--- GET /review title:";  curl -s "http://127.0.0.1:$PORT/review" | grep -o '<title>[^<]*</title>'
    echo "--- /api/session:";       curl -s "http://127.0.0.1:$PORT/api/session" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log(JSON.stringify({title:d.request.title,kind:d.request.kind,meta:d.request.meta,files:d.files.map(f=>[f.status,f.newPath])}))})"
    echo "--- POST decision accept:"; curl -s -X POST "http://127.0.0.1:$PORT/api/decision" -H 'content-type: application/json' -d '{"action":"accept"}'; echo
    wait $PID
    echo "--- hook stdout:"; cat "$TMPDIR/hook-out.json"
    echo "--- hook stderr:"; cat "$TMPDIR/hook-err.txt"
    ;;
  edit-accept-session)
    hook_input Edit '{"file_path":"'"$REPO"'/app.ts","old_string":"line three","new_string":"line 3!"}' \
      | HOME="$TH" $CLI hook-run > "$TMPDIR/hook-out.json" 2> "$TMPDIR/hook-err.txt" &
    PID=$!
    PORT=$(find_port)
    curl -s -X POST "http://127.0.0.1:$PORT/api/decision" -H 'content-type: application/json' -d '{"action":"accept_session"}' > /dev/null
    wait $PID
    echo "--- hook stdout:"; cat "$TMPDIR/hook-out.json"
    echo "--- always flags:"; ls "$TH/.agent-change-reviewer/always-allow"
    echo "--- second run (should allow instantly, no server):"
    hook_input Edit '{"file_path":"'"$REPO"'/app.ts","old_string":"line one","new_string":"line 1!"}' \
      | HOME="$TH" $CLI hook-run
    ;;
  review-request-changes)
    rm -rf "$TH/.agent-change-reviewer/always-allow"
    hook_input Write '{"file_path":"'"$REPO"'/new.ts","content":"export const x = 1;\n"}' \
      | HOME="$TH" $CLI hook-run > "$TMPDIR/hook-out.json" 2> "$TMPDIR/hook-err.txt" &
    PID=$!
    PORT=$(find_port)
    echo "--- file status in diff:"; curl -s "http://127.0.0.1:$PORT/api/session" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log(JSON.stringify(d.files.map(f=>[f.status,f.newPath])))})"
    echo "--- submit request_changes via full UI endpoint:"
    curl -s -X POST "http://127.0.0.1:$PORT/api/submit" -H 'content-type: application/json' \
      -d '{"verdict":"request_changes","summary":"Name it better","comments":[{"file":"new.ts","side":"new","line":1,"body":"x is not a name"}]}'; echo
    wait $PID
    echo "--- hook stdout:"; cat "$TMPDIR/hook-out.json"
    ;;
  reject-reason)
    hook_input Edit '{"file_path":"'"$REPO"'/app.ts","old_string":"line one","new_string":"gone"}' \
      | HOME="$TH" $CLI hook-run > "$TMPDIR/hook-out.json" 2> "$TMPDIR/hook-err.txt" &
    PID=$!
    PORT=$(find_port)
    curl -s -X POST "http://127.0.0.1:$PORT/api/decision" -H 'content-type: application/json' -d '{"action":"reject","reason":"keep line one, refactor app.ts instead"}' > /dev/null
    wait $PID
    echo "--- hook stdout:"; cat "$TMPDIR/hook-out.json"
    ;;
  codex-accept)
    PATCH='*** Begin Patch\n*** Update File: app.ts\n-line two\n+line two (codex)\n*** End Patch'
    printf '{"session_id":"codex1","cwd":"%s","tool_name":"apply_patch","tool_input":{"command":"%s"}}' "$REPO" "$PATCH" \
      | HOME="$TH" $CLI hook-run > "$TMPDIR/hook-out.json" 2> "$TMPDIR/hook-err.txt" &
    PID=$!
    PORT=$(find_port)
    echo "--- /api/session:"; curl -s "http://127.0.0.1:$PORT/api/session" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log(JSON.stringify({title:d.request.title,meta:d.request.meta,files:d.files.map(f=>[f.status,f.newPath])}))})"
    curl -s -X POST "http://127.0.0.1:$PORT/api/decision" -H 'content-type: application/json' -d '{"action":"accept"}' > /dev/null
    wait $PID
    echo "--- hook stdout:"; cat "$TMPDIR/hook-out.json"
    ;;
  noop-paths)
    echo "--- edit that will fail (old_string missing) -> pass:"
    hook_input Edit '{"file_path":"'"$REPO"'/app.ts","old_string":"NO SUCH","new_string":"x"}' | HOME="$TH" $CLI hook-run; echo "exit=$?"
    echo "--- identical write -> pass:"
    hook_input Write '{"file_path":"'"$REPO"'/app.ts","content":"line one\nline two\nline three\n"}' | HOME="$TH" $CLI hook-run; echo "exit=$?"
    echo "--- non-edit tool -> pass:"
    hook_input Bash '{"command":"ls"}' | HOME="$TH" $CLI hook-run; echo "exit=$?"
    echo "--- garbage stdin -> pass:"
    echo "not json" | HOME="$TH" $CLI hook-run; echo "exit=$?"
    ;;
  install)
    mkdir -p "$TH/.claude"
    printf '{"model":"opus","hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi"}]}]}}\n' > "$TH/.claude/settings.json"
    HOME="$TH" $CLI hook install
    HOME="$TH" $CLI hook status
    echo "--- settings.json:"; cat "$TH/.claude/settings.json"
    HOME="$TH" $CLI hook install   # idempotent
    HOME="$TH" $CLI hook uninstall
    echo "--- settings.json after uninstall:"; cat "$TH/.claude/settings.json"
    ;;
  *)
    echo "usage: bash test-hook.sh <setup|edit-accept|edit-accept-session|review-request-changes|reject-reason|noop-paths|install>"
    ;;
esac
