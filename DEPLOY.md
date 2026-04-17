# 部署：让策略 24 小时跑在云端

项目需要 **Node.js 20 + Python 3**。推荐两条路：

- **路 A：Railway（零 Linux、点点就好，约 $5/月）** ← 如果你没碰过服务器，选这个
- **路 B：VPS（腾讯云/Hetzner/Vultr，约 ¥24–¥36/月）**

无论哪条路，部署成功后访问 `https://你的域名/live`：保存 API → 绑定策略 → 设置风控 → 启动。

---

## 通用前置（必做）

### 1. 在 Binance 创建 API

1. 登录币安 → 「API 管理」→ 创建
2. **强烈建议**：
   - 开启 **IP 白名单**（填你 VPS/Railway 出口 IP，见下文各段末尾）
   - **关闭提现权限**
   - 只勾「**读取**」+「**启用现货及杠杆交易**」
3. 复制 Key 与 Secret。**Secret 只显示一次**。

> 提示：币安合约 API **不能用美国 IP**；现货 API 在大多地区可用，但**国内 IP 易被限流**，建议香港/日本/新加坡。

### 2. 推上 GitHub
```bash
cd /你的本地/coral-strategy-protocol
git add -A
git commit -m "feat: live runner + deploy"
git remote add origin https://github.com/你的名字/coral.git   # 改成你的仓库
git push -u origin main
```

### 3. 想好两个"密码"
- `APP_PASSWORD`：登录网页的口令（你自己定，**至少 10 位**）
- Binance 的 API Key / Secret：见上面

---

## 路 A：Railway（最省事）

Railway 是「把代码交给它，它一键部署并让进程一直跑」的托管平台。

### 1. 注册
- 打开 <https://railway.app>
- 点 **"Login with GitHub"**，授权

### 2. 从仓库创建项目
- 控制台点 **"New Project"** → **"Deploy from GitHub repo"** → 选你的仓库
- Railway 检测到根目录有 `Dockerfile`，自动用它构建
- 第一次构建约 3–5 分钟

### 3. 配置环境变量
项目页 → **Variables** 标签，添加：

| 变量 | 值 |
|---|---|
| `APP_PASSWORD` | 你定的网页口令 |
| `ANTHROPIC_API_KEY` | 如果要用 Claude 翻译/进化 |
| `DEEPSEEK_API_KEY` | 如果要用 DeepSeek |
| `BINANCE_API_KEY` | Binance API Key（可选，也可在网页里保存） |
| `BINANCE_API_SECRET` | Binance Secret（同上） |

> 填了 `BINANCE_API_*` 环境变量后，网页无需再次保存；留空则第一次访问 `/live` 时在网页保存一次。

### 4. 打开外部域名
- 项目页 → **Settings** → **Networking** → **"Generate Domain"**
- Railway 会给一个 `xxx.up.railway.app` 的 HTTPS 域名

### 5. 第一次登录 & 启动
1. 访问 `https://xxx.up.railway.app`，输入 `APP_PASSWORD`
2. 首页用自然语言生成策略 → 在策略页 URL 里复制 `id=sess_xxx`
3. 访问 `/live`：
   - 「1. API 凭据」若没用环境变量，此处保存一次
   - 「2. 绑定策略」粘贴 `sess_xxx`，点绑定
   - 「3. 守护进程」**先留在 `paper` 模式**，点启动
4. 等几根 K 线，确认「5. 最近事件」有正常 tick 日志
5. 观察 1–2 天后，回到「3. 守护进程」切到 `live` 模式 → 保存 → 重启

### Railway 常见问题
- **币安 IP 白名单**：Railway 的出口 IP 会变，建议 **不要设 IP 白名单**（或多填几个）
- **容器重启后策略是否继续**：Dockerfile 的 `scripts/start.sh` 会自动恢复已绑定的策略
- **Volume 数据**（历史事件、绑定策略）：Railway 默认容器无持久化，重部署后 `.live/` 会清空；强持久需要在 Settings → Volumes 挂一个 `/app/.live`

---

## 路 B：VPS（自由度高，便宜）

以**腾讯云轻量应用 · 香港节点**为例（其它家流程类似）。

### 1. 买服务器
- 打开腾讯云「轻量应用服务器」，**地域选香港**
- **实例规格**：2 核 2G 以上（够跑 Next + Python）
- 镜像选 **Ubuntu 22.04 LTS**
- 付款 → 等 1 分钟创建完毕

### 2. 登录服务器
- 在控制台找到服务器 → 右边点 **"登录"**（浏览器网页 SSH，不用装工具）
- 进入命令行界面

### 3. 安装环境（复制粘贴）

```bash
# 一键装好 Node 20 + Python 3 + git
sudo apt update && sudo apt install -y git python3 python3-pip curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 克隆项目
cd ~
git clone https://github.com/你的名字/coral.git
cd coral

# 依赖
npm ci
pip3 install --break-system-packages -r python/requirements.txt

# 构建
npm run build
```

### 4. 配置环境变量

```bash
cp .env.local.example .env.local 2>/dev/null || true
cat > .env.local <<'EOF'
APP_PASSWORD=你定的网页口令
ANTHROPIC_API_KEY=sk-ant-xxx
DEEPSEEK_API_KEY=sk-xxx
# Binance 可选；也可在网页里保存
BINANCE_API_KEY=
BINANCE_API_SECRET=
EOF
```

### 5. 注册 systemd 服务（开机自启 + 自动重启）

```bash
sudo tee /etc/systemd/system/coral-web.service >/dev/null <<EOF
[Unit]
Description=Coral Next.js Web
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/coral
EnvironmentFile=/root/coral/.env.local
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/coral-runner.service >/dev/null <<EOF
[Unit]
Description=Coral Live Runner
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/coral
EnvironmentFile=/root/coral/.env.local
ExecStart=/usr/bin/python3 /root/coral/python/live_runner.py
Restart=always
RestartSec=10
StandardOutput=append:/root/coral/.live/runner.log
StandardError=append:/root/coral/.live/runner.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now coral-web coral-runner
```

### 6. 开防火墙

```bash
# 腾讯云轻量：控制台「防火墙」新增 3000 入站规则
# （如果要挂域名 + HTTPS，后面再装 nginx + certbot）
```

### 7. 访问
- 复制服务器公网 IP，浏览器打开 `http://公网IP:3000`
- 用 `APP_PASSWORD` 登录
- 去 `/live`：保存 API（如果没在 .env 写）→ 绑定策略 → 启动

> 注意：UI 的 **启动/停止** 按钮在 VPS 上**不会影响 systemd 层的 coral-runner**。要彻底停 runner 请用：
> ```bash
> sudo systemctl stop coral-runner
> sudo systemctl disable coral-runner
> ```
> 日常切到空仓只需把 `.live/runner_config.json` 的 `mode` 改回 `paper`，或解除绑定。

### Binance IP 白名单（VPS）
```bash
curl -s https://ifconfig.me  # 拿到服务器公网 IP
# 在 Binance API 设置里把这个 IP 加到白名单
```

---

## 两种方案的对比速查

|   | Railway | VPS |
|---|---|---|
| 每月费用 | ~$5 | ¥24 左右 |
| 部署时间 | 10 分钟 | 30 分钟 |
| Linux 技能 | 0 | 会复制命令即可 |
| 自定义域名 | 自动 HTTPS | 需 nginx + certbot |
| 数据持久化 | 要手动挂 Volume | 直接写 `.live/` 持久 |
| IP 稳定 | 会变（白名单麻烦） | 固定（白名单方便） |
| 升级策略 | `git push` 自动部署 | `cd coral && git pull && npm run build && sudo systemctl restart coral-web coral-runner` |

---

## 安全自查清单

- [ ] `APP_PASSWORD` 足够长（10 位以上）
- [ ] Binance API **关闭提现**
- [ ] `.env.local`、`.live/binance.json` **没被 `git push` 出去**（`.gitignore` 已覆盖）
- [ ] 第一次开实盘前至少跑过 **1 天 paper**
- [ ] 启用 `stop_loss_pct`（默认 5%）
- [ ] 单笔 `max_order_usdt` 不要一上来就几千 U，建议 **20–50 U 观察期**

## 故障诊断

- 登录不上：`docker logs` 或 `sudo journalctl -u coral-web -n 200` 看报错
- 策略没跑：
  - `/api/live/runner/status` 返回 `running: false` → 点启动
  - `state.reason=no_active_strategy` → 去绑定策略
  - `state.reason=no_credentials` → 去填 API
- 下单失败：看事件列表里的 `error` 字段，常见原因：
  - `-2010` 余额不足
  - `-1013` 单笔低于最小金额（BTCUSDT 现货最小 ≈ 5 USDT）
  - `-2015` IP 白名单 / 权限 / Key 错
