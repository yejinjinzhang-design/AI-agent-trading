#!/bin/sh
# 容器启动：
# 1) 若本机存在绑定策略文件，自动恢复守护进程（避免重启后策略不再跑）
# 2) 启动 Next.js standalone 服务
set -e

cd /app

if [ -f /app/.live/active_strategy.json ]; then
  echo "[boot] detected active_strategy.json, starting live runner in background"
  (python3 /app/python/live_runner.py >> /app/.live/runner.log 2>&1 &)
  sleep 1
fi

exec node /app/server.js
