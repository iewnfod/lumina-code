# lumina-server

Lumina Code 的自部署配套服务器：一个 Next.js 单体应用 = **用户系统 +
Web 管理界面 + 远程访问凭证交换**，SQLite 单文件存储；与 frps 容器
一起部署（见下）。

## 架构定位（frp 直连模型）

```
桌面 Lumina Code ──frpc 出站（TLS）──▶ frps :14601（控制信道）
  本地 opencode（agent 始终在本机）              ▲ HTTP vhost :14602（仅回环）
  └─ 注册引擎：opencode 密码 + 路由 id ◀─凭证交换─┤
                                                │
移动端 App ──HTTPS──▶ 你的 nginx ──/t/<routeId>/─┘ （Host 改写路由）

- **会话内容完全不经过服务器**：桌面在线时，移动端通过 frp 路由
  **直连**桌面的 opencode（真流式）；服务器只做凭证交换（路由 id +
  桌面 opencode 的 Basic 密码，桌面心跳刷新）。
- 代码、模型 API key、git 仓库都留在桌面；服务器上没有会话数据。
- 信任圈变化：opencode 密码会**存放在本服务器**并发放给任何持有效
  设备 token 的客户端；frps token 对所有账号共享。这是面向自托管
  单操作者场景的有意取舍（详见下方"远程访问"一节）。

## 快速开始

### Docker（推荐）

```bash
# 仓库根目录 — compose 拉取 CI 发布的镜像（amd64 + arm64）
# master 推送 → :edge；GitHub Release → :<版本号> + :latest
docker compose up -d
# 更新到新版 :latest：docker compose pull && docker compose up -d
# 打开 http://<host>:14600/ 注册第一个账号（自动成为 admin）
```

不想用 compose 也可以直接 run（远程访问需自行在旁边跑一个 frps，
配置对齐 `server/deploy/frps.toml` 与 `LUMINA_FRPS_TOKEN`）：

```bash
docker run -d --name lumina-server -p 14600:3000 \
  -v lumina-data:/data iewnfod/lumina-code-server:latest
```

### 从源码构建镜像

```bash
docker build -f server/Dockerfile -t lumina-code-server .
docker run -d -p 14600:3000 -v lumina-data:/data lumina-code-server
```

数据就是卷里的 `lumina.db` 一个文件，备份即拷贝。

### 裸机 / 开发

```bash
pnpm install
pnpm server:dev        # http://localhost:14600
pnpm server:build && (cd server && npx next start)
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUMINA_DATA_DIR` | `./data` | SQLite 文件所在目录（自动创建） |
| `LUMINA_ALLOW_REGISTRATION` | `true` | `false` 关闭注册（已有账号仍可登录） |
| `LUMINA_COOKIE_SECURE` | `0` | `1` 时登录 cookie 标记 Secure（仅当本服务自身走 TLS） |
| `LUMINA_FRPS_TOKEN` | 空 | frp 远程访问开关：与 `server/deploy/frps.toml` 的 `auth.token` 一致；留空 = 不提供远程访问 |
| `LUMINA_FRPS_BIND_PORT` | `7000` | frps 控制信道的【宿主机】端口（桌面 frpc 连它；compose 里是 14601） |
| `PORT` | Next 默认 | 容器内监听 3000，compose 映射到 14600 |

## 桌面端接入

Lumina Code → 设置 → **服务器**：填服务器地址 + 用户名密码登录，打开
**远程访问**开关即建立 frp 直连通道。退出登录会吊销该设备的 token。

## 远程访问：frp 直连（移动端）

移动端不经过任何中转协议：桌面的 frpc 出站连到 frps，移动端经
`https://<server>/t/<routeId>/` **直接**访问桌面 opencode（真正的
SSE 流式）。服务器只做凭证交换：

```
桌面 frpc ──出站 TLS──▶ frps :14601（控制信道）
移动端 ──HTTPS──▶ nginx ──/t/<routeId>/ + Host 改写──▶ frps vhost :14602（仅回环）
                                                          │ 按 Host 路由
                                                          ▼
                                                     桌面 opencode
```

部署三步：

1. **改 token**：`server/deploy/frps.toml` 的 `auth.token` 与 compose 里
   `LUMINA_FRPS_TOKEN` 填同一个随机串（`openssl rand -hex 16`）。
2. **`docker compose up -d`**：frps 服务随 compose 一起起来（14601 公网、
   14602 仅宿主机回环）。
3. **nginx 加 /t/ 路由**（TLS 终结 + 路径剥离 + Host 改写；`proxy_buffering
   off` 三件套对流式是硬要求，nginx 默认开 buffering 会把 SSE 攒批）：

```nginx
location / {
    proxy_pass http://127.0.0.1:14600;                   # lumina-server 本体
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location ~ ^/t/(?<frp_route>[A-Za-z0-9_-]+)/(?<frp_path>.*) {
    proxy_pass http://127.0.0.1:14602/$frp_path$is_args$args;
    proxy_set_header Host $frp_route.frp.internal;       # frps 按此路由
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;                                  # SSE 关键
    proxy_cache off;
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
    client_max_body_size 100m;                            # 附件上传
}
```

nginx 在容器里跑的话，把 `127.0.0.1:14602` 换成 compose 网络里的
`frps:7100`（容器内端口），并去掉 compose 里 14602 的回环发布。

**信任模型（务必知悉）**：

- 桌面 opencode 的 Basic-auth 密码会**存放在本服务器**并发放给任何
  持有效设备 token 的客户端——被攻破的本服务器即等于直接拿到桌面
  opencode 的完整 API。这是相对旧隧道模型（密码不出桌面）的有意取舍。
- frps 的 `auth.token` 对所有账号共享：互不信任的多租户部署里，一个
  恶意账号理论上可注册他人路由。本服务器面向自托管单操作者场景，
  不要给不信任的人开账号。

## TLS 与网络（自行解决）

服务器本身不做 TLS。公网/跨网访问请放在反向代理后面：

- **Caddy**（自动 HTTPS）：`lumina.example.com { reverse_proxy 127.0.0.1:14600 }`
- **nginx + certbot** 同理。
- 内网/家庭网络：Tailscale / WireGuard / frp 都是常见选择——客户端只是
  填一个可达的地址，组网方式完全由你决定。

反向代理需保留 `x-forwarded-for`（登录限流按 IP 计数）。

## API 一览

| 端点 | 说明 |
|---|---|
| `POST /api/auth/register` | `{username,password}` → `{token,user}`（首个用户为 admin） |
| `POST /api/auth/login` | 同上；每次登录签发新设备 token |
| `GET /api/auth/me` / `POST /api/auth/logout` | 校验 / 吊销当前 token |
| `GET·DELETE /api/tokens[/id]` | 设备 token 管理 |
| `GET·PATCH /api/admin/users` | 用户管理（admin） |
| `GET /api/frp/config` | 桌面用：frps 控制信道端口 + 共享 token（未配置 → `enabled:false`） |
| `PUT /api/frp/routes` | 桌面用：注册/心跳 opencode 密码，铸/复用路由 id |
| `GET /api/frp/connect` | 移动端用：当前路由 id + 密码 + 最近心跳时间 |

认证：`Authorization: Bearer lum_…`（API）或同名 httpOnly cookie（Web UI）。
CORS 对 `/api/*` 全开（Bearer 认证不依赖 cookie，无凭证泄露面）。

## 开发

```bash
pnpm server:test        # vitest（db / auth / frp）
pnpm server:typecheck
pnpm server:build
```

代码结构：`src/db`（schema+连接）、`src/lib`（auth/frp 纯逻辑+测试）、
`src/app/api`（路由）、`src/app/(protected)`（管理界面）、
`src/middleware.ts`（CORS）。
