#!/bin/sh
set -eu

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <name> <command> [args...]" >&2
  exit 64
fi

NAME="$1"
shift

LOG_FILE="${CORAL_LOG_FILE:-}"
RESTART_DELAY="${CORAL_RESTART_DELAY_SECONDS:-5}"
STOP_REQUESTED=0
CHILD_PID=""

log() {
  printf '[supervisor] [%s] %s\n' "$NAME" "$1"
}

stop_child() {
  if [ -n "${CHILD_PID:-}" ]; then
    kill "$CHILD_PID" 2>/dev/null || true
  fi
}

on_term() {
  STOP_REQUESTED=1
  log "stop requested, forwarding signal"
  stop_child
}

trap on_term INT TERM

while [ "$STOP_REQUESTED" -eq 0 ]; do
  log "starting: $*"
  if [ -n "$LOG_FILE" ]; then
    "$@" >>"$LOG_FILE" 2>&1 &
  else
    "$@" &
  fi
  CHILD_PID=$!

  set +e
  wait "$CHILD_PID"
  EXIT_CODE=$?
  set -e
  CHILD_PID=""

  if [ "$STOP_REQUESTED" -ne 0 ]; then
    log "stopped"
    exit 0
  fi

  log "exited with code $EXIT_CODE, restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY"
done
