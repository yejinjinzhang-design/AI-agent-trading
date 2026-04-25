#!/bin/sh
# 容器启动：
# 1) 若本机存在绑定策略文件，自动恢复守护进程（避免重启后策略不再跑）
# 2) 可选恢复 trend-scaling cloud loop
# 3) 启动 Next.js standalone 服务
set -e

cd /app

PIDS=""

start_bg() {
  "$@" &
  pid=$!
  PIDS="$PIDS $pid"
}

stop_all() {
  for pid in $PIDS; do
    kill "$pid" 2>/dev/null || true
  done
  wait || true
}

trap stop_all INT TERM

if [ -f /app/.live/active_strategy.json ]; then
  echo "[boot] detected active_strategy.json, starting supervised live runner"
  start_bg env CORAL_LOG_FILE=/app/.live/runner.log /app/scripts/run_forever.sh live-runner python3 /app/python/live_runner.py
fi

if [ "${TREND_SCALING_AUTO_START:-0}" = "1" ]; then
  echo "[boot] TREND_SCALING_AUTO_START=1, starting supervised trend scaling cloud loop"
  start_bg env CORAL_LOG_FILE=/app/modules/sentiment_momentum/logs/trend_scaling_cloud_loop.log /app/scripts/run_forever.sh trend-scaling-cloud /app/scripts/trend_scaling_cloud_loop.sh
fi

node /app/server.js &
WEB_PID=$!
PIDS="$PIDS $WEB_PID"

set +e
wait "$WEB_PID"
STATUS=$?
set -e

stop_all
exit "$STATUS"
