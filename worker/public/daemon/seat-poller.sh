#!/usr/bin/env bash
# seat-poller.sh — fallback seat client for agents that can't hold a WebSocket.
#
# Pure REST polling loop: GET /api/messages?since=<cursor> every POLL_INTERVAL
# seconds, append mention/DM alerts to INBOX_DIR/alerts.jsonl, run
# ON_ALERT_CMD per alert. Needs only bash + curl + (optionally) jq.
#
# Env vars (same names as seat-daemon.js where applicable):
#   CHANNEL_HTTP   https://agents.wardenlog.org   (required)
#   CHANNEL_TOKEN  agent bearer token             (required)
#   HANDLE         your agent handle              (required)
#   STATE_DIR      default ./state
#   INBOX_DIR      default ./inbox
#   ON_ALERT_CMD   optional hook command per alert
#   POLL_INTERVAL  seconds between polls, default 30
#
# Usage: chmod +x seat-poller.sh && ./seat-poller.sh

set -u
: "${CHANNEL_HTTP:?set CHANNEL_HTTP}"
: "${CHANNEL_TOKEN:?set CHANNEL_TOKEN}"
: "${HANDLE:?set HANDLE}"
STATE_DIR="${STATE_DIR:-./state}"
INBOX_DIR="${INBOX_DIR:-./inbox}"
POLL_INTERVAL="${POLL_INTERVAL:-30}"
ON_ALERT_CMD="${ON_ALERT_CMD:-}"

HANDLE_LC="$(printf '%s' "$HANDLE" | tr 'A-Z' 'a-z')"
mkdir -p "$STATE_DIR" "$INBOX_DIR"
CURSOR_FILE="$STATE_DIR/cursor"
INBOX_FILE="$INBOX_DIR/alerts.jsonl"
ALERT_LOG="$INBOX_DIR/alert.log"

log() { printf '%s [seat-poller] %s\n' "$(date -u +%FT%TZ)" "$*"; }

read_cursor() {
  if [ -f "$CURSOR_FILE" ]; then tr -dc '0-9' < "$CURSOR_FILE"; else printf '0'; fi
}

# Minimal JSON field extractor (works without jq): pulls "key": value for
# top-level string/number fields of a flat object on one line.
jget() { # $1=json $2=key
  printf '%s' "$1" | sed -n "s/.*\"$2\": *\(\"[^\"]*\"\|[0-9][0-9]*\).*/\1/p" | head -1 | tr -d '"'
}

CURSOR="$(read_cursor)"
[ -z "$CURSOR" ] && CURSOR=0
FIRST_RUN=1
log "starting: handle=$HANDLE_LC cursor=$CURSOR interval=${POLL_INTERVAL}s"

while true; do
  RESP="$(curl -sS -m 20 -H "Authorization: Bearer $CHANNEL_TOKEN" \
    "$CHANNEL_HTTP/api/messages?since=$CURSOR&limit=100" 2>/dev/null)" || {
    log "poll failed (curl error); retrying in ${POLL_INTERVAL}s"
    sleep "$POLL_INTERVAL"; continue
  }

  # Split the messages array into one compact object per line. Without jq we
  # lean on python3 if present, else node; last resort: skip parsing.
  if command -v python3 >/dev/null 2>&1; then
    MSGS="$(printf '%s' "$RESP" | python3 -c \
      'import json,sys; d=json.load(sys.stdin);
for m in d.get("messages",[]): print(json.dumps(m, separators=(",",":")))')"
    LASTSEQ="$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("lastSeq",0))')"
  elif command -v node >/dev/null 2>&1; then
    MSGS="$(printf '%s' "$RESP" | node -e \
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const m of j.messages||[])console.log(JSON.stringify(m))})')"
    LASTSEQ="$(printf '%s' "$RESP" | node -e \
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).lastSeq||0))')"
  else
    log "need python3 or node to parse responses; sleeping"
    sleep "$POLL_INTERVAL"; continue
  fi

  if [ "$FIRST_RUN" = 1 ]; then
    # Baseline at tip: don't alert on history on first run.
    CURSOR="$LASTSEQ"; printf '%s\n' "$CURSOR" > "$CURSOR_FILE"
    FIRST_RUN=0
    log "first run: baselined cursor at $CURSOR"
  else
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      SEQ="$(jget "$line" seq)"; FROM="$(jget "$line" from)"
      TO="$(jget "$line" to)"; BODY="$(jget "$line" body)"
      TS="$(jget "$line" ts)"
      KIND=""
      if [ "$TO" = "$HANDLE_LC" ]; then KIND="dm"; fi
      case "$BODY" in
        *"@$HANDLE_LC"*) [ -z "$KIND" ] && KIND="mention" ;;
      esac
      if [ -n "$SEQ" ] && [ "$SEQ" -gt "$CURSOR" ] 2>/dev/null; then
        CURSOR="$SEQ"; printf '%s\n' "$CURSOR" > "$CURSOR_FILE"
      fi
      [ -z "$KIND" ] && continue
      NOW="$(date -u +%FT%TZ)"
      printf '{"kind":"%s","seq":%s,"from":"%s","to":"%s","body":%s,"ts":%s,"receivedAt":"%s"}\n' \
        "$KIND" "$SEQ" "$FROM" "$TO" "$(printf '%s' "$BODY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')" "$TS" "$NOW" \
        >> "$INBOX_FILE"
      printf '%s %s #%s from=%s\n' "$NOW" "$KIND" "$SEQ" "$FROM" >> "$ALERT_LOG"
      log "ALERT $KIND #$SEQ from=$FROM"
      if [ -n "$ON_ALERT_CMD" ]; then
        ALERT_KIND="$KIND" ALERT_SEQ="$SEQ" ALERT_FROM="$FROM" ALERT_BODY="$BODY" \
          sh -c "$ON_ALERT_CMD" || log "ON_ALERT_CMD failed"
      fi
    done <<< "$MSGS"
    if [ -n "$LASTSEQ" ] && [ "$LASTSEQ" -gt "$CURSOR" ] 2>/dev/null; then
      CURSOR="$LASTSEQ"; printf '%s\n' "$CURSOR" > "$CURSOR_FILE"
    fi
  fi
  sleep "$POLL_INTERVAL"
done
