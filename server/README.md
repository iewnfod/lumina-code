# lumina-server

Lumina Code 的自部署配套服务器：一个 Next.js 单体应用 = **用户系统 +
Web 管理界面 + session 镜像 API**，SQLite 单文件存储。

## 架构定位（中继模型）

```
桌面 Lumina Code ──HTTPS 出站（Bearer token）──▶ lumina-server
  本地 opencode（agent 始终在本机）               ├─ SQLite: users/tokens/sessions/messages
  └─ 同步引擎：session 列表 + 消息快照镜像         ├─ /api/auth/*  /api/sync/*
                                                  └─ Web 管理界面（/login /users /sessions …）
```

- **代码不离开你的机器之外的地方**：agent、模型 API key、git 仓库都留在桌面；
  服务器只接收会话列表与消息快照（transcript 镜像），供其他设备浏览。
- 桌面在线是移动端交互的前提（v1 不含 prompt 转发——那是下一个里程碑）。
- 信任圈模型：所有登录用户可见全部已同步会话；目录级 ACL 是后续工作。

## 快速开始

### Docker（推荐）

```bash
# 仓库根目录
docker compose up -d
# 打开 http://<host>:4600/ 注册第一个账号（自动成为 admin）
```

数据就是卷里的 `lumina.db` 一个文件，备份即拷贝。

### 裸机 / 开发

```bash
pnpm install
pnpm server:dev        # http://localhost:4600
pnpm server:build && (cd server && npx next start)
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUMINA_DATA_DIR` | `./data` | SQLite 文件所在目录（自动创建） |
| `LUMINA_ALLOW_REGISTRATION` | `true` | `false` 关闭注册（已有账号仍可登录） |
| `LUMINA_COOKIE_SECURE` | `0` | `1` 时登录 cookie 标记 Secure（仅当本服务自身走 TLS） |
| `PORT` | Next 默认 | 容器内监听 3000，compose 映射到 4600 |

## 桌面端接入

Lumina Code → 设置 → **服务器**：填服务器地址 + 用户名密码登录即启用同步。
开关只暂停镜像，退出登录会吊销该设备的 token。

## TLS 与网络（自行解决）

服务器本身不做 TLS。公网/跨网访问请放在反向代理后面：

- **Caddy**（自动 HTTPS）：`lumina.example.com { reverse_proxy 127.0.0.1:4600 }`
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
| `GET·POST /api/sync/sessions` | 会话列表镜像（读 / 全量推送+墓碑） |
| `GET·POST /api/sync/sessions/{id}/messages` | 消息快照（读 / 整体替换） |

认证：`Authorization: Bearer lum_…`（API）或同名 httpOnly cookie（Web UI）。
CORS 对 `/api/*` 全开（Bearer 认证不依赖 cookie，无凭证泄露面）。

## 开发

```bash
pnpm server:test        # vitest（db / auth / sync / transcript）
pnpm server:typecheck
pnpm server:build
```

代码结构：`src/db`（schema+连接）、`src/lib`（auth/sync 纯逻辑+测试）、
`src/app/api`（路由）、`src/app/(protected)`（管理界面）、
`src/middleware.ts`（CORS）。
