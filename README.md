# 企业级多人协同文档工作区

基于 **Vue3 + TypeScript + Pinia + Element Plus + WebSocket** 的企业级多文档协同工作台。
提供**多租户工作区、文档目录与成员权限体系**；多人同时编辑 / 批注同一文档，
使用 **OT（Operational Transformation）** 解决并发冲突，并具备权限在线调整、
在途操作实时拦截、完整审计记录与断网重连能力。

## 功能一览

### 多租户与权限

- **账号体系**：注册 / 登录（scrypt 加盐哈希），令牌鉴权（HTTP Bearer Token + WS join 令牌）
- **企业工作区**：多工作区隔离，工作区管理员 / 普通成员两级；管理员隐式拥有区内全部文档管理权
- **文档目录与最近协作**：用户仅能看到被授权的文档；工作台展示工作区侧栏、文档目录、最近协作文档
- **文档级细粒度权限**：`viewer`（查看）/ `commenter`（批注）/ `editor`（编辑）/ `admin`（管理，兼具编辑权）
- **成员管理**：管理员为成员授权 / 调整角色 / 移除；权限调整**实时推送**在线连接，无需重连
- **在途操作拦截**：用户被在线降权后，其正在发送的编辑 / 批注被服务端立即拒绝，
  编辑端自动全量重同步、回滚未确认的乐观修改；被移除 / 文档被删除时强制退出
- **审计记录**：文档创建 / 重命名 / 删除、成员授权 / 角色调整 / 移除全部留痕，含操作人、旧值→新值与时间

### 协同编辑

- **实时协同**：多人在线编辑同一文档，操作经 OT 变换后收敛一致
- **划词批注**：选中文字添加批注，支持回复、解决、删除；批注锚点随编辑自动移动
- **在线状态**：在线用户列表、远程光标与选区实时展示（同一用户多标签页聚合为一个头像）
- **异常链路**：断网自动重连（指数退避）、离线编辑暂存、消息序号空洞检测、ack 超时重同步、版本过旧全量快照回滚
- **演示工具栏**：一键「模拟断线 / 重新连接」，直观展示离线编辑与重连同步

## 快速开始

```bash
# 1. 安装依赖（根目录 + server + client）
npm run setup
npm install            # 根目录 concurrently（仅 dev 需要）

# 2. 开发模式（server:8080 + vite:5173，/ws 与 /api 已配置代理）
npm run dev

# 3. 打开 http://localhost:5173
```

首次启动自动创建一个演示工作区与四个演示账号：

| 登录名 | 密码 | 角色 |
| --- | --- | --- |
| `admin` | `admin123` | 工作区 / 文档管理员 |
| `editor` | `editor123` | 编辑员 |
| `commenter` | `commenter123` | 批注员 |
| `viewer` | `viewer123` | 只读访客 |

可多开浏览器标签页，用不同账号登录体验：admin 在文档「成员权限」中把 editor 降为 viewer，
editor 的编辑器会立即变为只读，正在发送的编辑被拦截并回滚。

生产模式：

```bash
npm run build          # 构建客户端到 client/dist
npm start              # 服务端托管 API + WS + 静态页面：http://localhost:8080
```

测试与类型检查：

```bash
npm test               # OT fuzz 单元测试 + 协同 e2e + 多租户权限 e2e（共 32 项）
npm run typecheck      # server tsc + client vue-tsc
```

## 目录结构

```
├── shared/               # 前后端共享代码
│   ├── ot.ts             #   OT 核心：apply / transformPair / compose / invert / mapPosition / diffToOp
│   ├── protocol.ts       #   WS 协议：角色、批注、全部实时消息（含 perm:changed / doc:closed）
│   └── tenant.ts         #   租户领域模型 + HTTP API DTO（用户/工作区/成员/文档/审计）
├── server/
│   └── src/
│       ├── store.ts      #   多租户数据层：账号、工作区、成员、文档授权、审计、令牌
│       ├── api.ts        #   HTTP REST API（/api/**）与鉴权
│       ├── docSession.ts #   文档会话：版本日志、OT 变换、批注、在线角色变更
│       └── index.ts      #   HTTP + WS 入口、令牌鉴权、权限实时推送、心跳、持久化
│   └── test/
│       ├── ot.test.ts          # OT 性质 fuzz
│       ├── e2e.test.ts         # 协同 e2e（并发·权限·重连·快照·鉴权）
│       ├── otClient.e2e.ts     # 真实客户端 OTClient × 真实服务端
│       ├── tenant.e2e.ts       # 多租户：在线降权/在途拦截/移除/删除/审计/目录隔离
│       └── helpers.ts          # HTTP 登录/建文档/授权测试辅助
└── client/src/
    ├── api/http.ts       #   REST 客户端（令牌注入）
    ├── collab/collab.ts  #   编排层：连接 × OT × store，权限实时变更与降权回滚
    ├── ot/otClient.ts    #   OT 客户端状态机（未确认队列 / 发送节流 / ack 超时）
    ├── ws/wsClient.ts    #   WS 封装（自动重连 / 发送队列 / 心跳）
    ├── stores/           #   auth（账号令牌）/ workspace（目录·成员·审计）/ session / doc
    └── components/       #   LoginGate / WorkspaceView（工作台）/ DocMembersDialog
                          #   WorkspaceMembersDialog / AuditDialog / EditorView / AnnotationPanel / TopBar
```

## 权限模型

```
工作区（Workspace）
├── 工作区成员：admin（管理员）/ member（普通成员）
│     └── 工作区 admin 隐式拥有区内所有文档的 admin 权限
└── 文档（Doc）
      └── 文档成员：viewer / commenter / editor / admin（显式授权记录）
            viewer    → 查看正文、批注、他人光标
            commenter → 查看 + 添加/回复/解决批注
            editor    → 批注 + 编辑正文
            admin     → 编辑 + 管理成员授权、重命名/删除文档、查看审计
```

有效角色解析（`TenantStore.resolveDocRole`）：**显式文档授权优先；无显式记录时，
工作区管理员隐式为 `admin`；其余工作区成员无权访问**。文档目录、最近协作、HTTP 接口、
WS join 与每条协同消息全部以此为准，客户端自选角色被完全忽略。

## 核心设计

### 身份与会话关联

- 登录成功服务端签发不透明令牌（仅内存保存，重启需重新登录）。
- HTTP 请求经 `Authorization: Bearer <token>` 鉴权；WS `join` 消息携带令牌，
  服务端解析出稳定 `userId`，再解析该用户在目标文档的有效角色，写入 `welcome`。
- `DocSession.ClientState` 关联 `userId`（而非易失的连接 ID）；批注 / 回复的
  `authorId` 使用稳定 userId，重连后仍可删除自己的批注。

### 在线权限调整与在途拦截

1. 管理员调用 `PUT /api/docs/:id/members` 调整角色 → 数据层更新并写审计；
2. 数据层触发 `onPermissionChange` 钩子 → `DocSession.updateUserRole` 更换该用户
   **所有在线连接**的角色，立即推送 `perm:changed`，并广播新的 `presence`；
3. 该连接后续的每条 `op` / `ann:*` 消息在 `DocSession` 内以**最新角色**重新校验，
   已降权用户的在途操作收到 `PERMISSION_DENIED`；编辑端据此全量重同步、丢弃未确认的乐观修改；
4. 角色为 `null`（被移出文档/工作区）或文档被删除时，服务端从会话移除连接、
   推送 `doc:closed` 并使该连接的会话引用失效（防止沿旧闭包继续操作），客户端退回工作台。

### HTTP REST API（摘要）

```
POST   /api/auth/register|login|logout        GET /api/me
GET    /api/recent                             最近协作文档
GET    /api/workspaces                         有权限的工作区
POST   /api/workspaces                         新建（创建者为 admin）
GET    /api/workspaces/:id                     工作区详情 + 成员
POST   /api/workspaces/:id/members             （工作区 admin）添加成员
PATCH  /api/workspaces/:id/members/:userId     （工作区 admin）调整工作区角色
DELETE /api/workspaces/:id/members/:userId     （工作区 admin）移除（级联收回文档授权）
GET    /api/workspaces/:id/docs                文档目录（仅含被授权文档）
POST   /api/workspaces/:id/docs                新建文档
GET    /api/workspaces/:id/audit               工作区审计（工作区 admin）
GET    /api/docs/:id                           文档详情 + 我的权限 + 成员
PATCH  /api/docs/:id                           重命名（文档 admin）
DELETE /api/docs/:id                           删除（文档 admin）
POST   /api/docs/:id/opened                    记录最近协作
GET    /api/docs/:id/members                   成员列表
PUT    /api/docs/:id/members                   授权 / 调整角色（body: username, role）
DELETE /api/docs/:id/members/:userId           移除成员
GET    /api/docs/:id/audit                     文档审计（文档 admin）
```

### OT 并发模型

文档为纯字符串，操作是 `retain(n) / insert(s) / delete(n)` 组件序列：

- 服务端为每个文档维护 `revision` 与操作日志（上限 1000 条）。客户端操作携带基准版本号；
  若已落后，服务端将其对落后期间的全部已接受操作**逐个变换**后应用，再广播给其他人。
- 客户端本地乐观应用，未确认操作进入队列（`unacked[0]` 已发送待确认，其余为缓冲，
  连续输入经 `compose` 合并）。远程操作到达时与全部未确认操作做双侧变换。
- 同位置并发插入的先后由「先被服务端接受者优先」的全局约定打破，保证各端收敛。
- 正确性由 `server/test/ot.test.ts` 中的随机 fuzz 性质测试保障。

### 批注锚点

批注锚定 `[start, end)` 区间。每次应用操作时用 `mapPosition` 移动锚点
（起点 `after`、终点 `before`）；锚点文本被完全删除时批注转为「孤儿」状态（📌，保留原文引用）。

### 断网重连与消息可靠性

| 异常 | 检测 | 恢复 |
| --- | --- | --- |
| 断网 / 假死 | WS close、应用层 ping/pong（10s/5s） | 指数退避重连，重连后带令牌 + `lastRevision` 重新 join |
| 离线编辑 | — | 编辑进入 OT 队列、批注进入 outbox，重同步后自动补发（若期间被降权则被服务端拦截并回滚） |
| 消息丢失（下行） | 广播携带单调 `seq`，检测空洞 | `resync` → 服务端补发 `ops`（按 opId 去重自己的操作） |
| 消息丢失（上行/ack） | ack 5s 超时 | 触发 resync |
| 版本过旧 / 在线降权 | 日志不足 / 权限不足 | 下发全量快照，客户端回滚未确认修改并以服务端为准 |

### 持久化

- 多租户数据（账号、工作区、成员、文档元数据、授权、最近协作、审计）防抖写入
  `server/data/tenants.json`；文档正文仍按 `server/data/doc-<docId>.json` 独立存储。
- 登录令牌仅保存在内存中，服务端重启后需重新登录（数据不丢）。

### 已知取舍（轻量化的边界）

- 文档为纯文本（非富文本），编辑器用 `textarea + 高亮背景层` 实现，避免 contenteditable 的选区/IME 复杂度。
- 单进程内存状态 + 文件持久化；多实例部署需引入共享存储与消息总线。
- 令牌为不透明随机 UUID（非 JWT），适合单进程演示；生产可替换为带过期时间的签名令牌。
- 批注锚点在「本地未确认操作 + 并发远程操作」的极端交错下可能与服务端有字符级偏差，任何重同步都会以服务端为准收敛。

## WS 协议摘要

客户端 → 服务端：`join`（**令牌** + docId + lastRevision）/ `op` / `cursor` /
`ann:add|reply|resolve|delete` / `resync` / `ping`

服务端 → 客户端：`welcome`（含 **userId、workspaceId、服务端解析的 role**）/ `ops` / `ack` /
`op` / `presence` / `cursor` / `ann:upsert|delete` /
**`perm:changed`（在线权限变更）** / **`doc:closed`（被移除/文档删除）** /
`error`（UNAUTHENTICATED、PERMISSION_DENIED、NOT_FOUND、RESYNC_REQUIRED…）/ `pong`
