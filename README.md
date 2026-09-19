# 企业级多人协同批注编辑器

基于 **Vue3 + TypeScript + Pinia + Element Plus + WebSocket** 的多人轻量协同批注编辑器。
多人同时编辑 / 批注同一文档，使用 **OT（Operational Transformation）** 解决并发冲突；
在单文档协同之上构建了**企业级多工作区（多租户）与成员细粒度权限体系**：
账号登录、工作区与文档目录、查看 / 批注 / 编辑 / 管理四级权限，
支持进入编辑器前权限加载、管理员在线改权实时生效、降权在途操作拦截与完整权限变更审计。

## 功能一览

- **多租户工作区**：账号注册/登录（scrypt 加盐哈希、Bearer 令牌会话）；工作区与成员管理；
  用户仅可见自己所属的工作区与被授权的文档；首页展示文档目录与「最近协作」
- **四级文档权限**：`viewer`（查看）/ `commenter`（批注）/ `editor`（编辑）/ `manager`（管理），
  服务端对每条 op / 批注 / 管理动作逐条按**当前**权限复核
- **在线改权实时生效**：管理员调整权限后，受影响用户的全部在线连接（多标签）立即收到
  `perm:update`；降权时本地即时禁用能力、丢弃未确认的越权编辑并全量回滚到服务端版本
- **在途操作拦截**：Node 单线程串行处理保证「推送降权」与「权限校验」严格有序，
  被降权用户已在网络缓冲中的下一条操作必以新角色被拒绝（`PERMISSION_DENIED`）
- **权限收回**：移除文档授权或被移出工作区时，在线连接收到 `perm:update(null)` 并以
  关闭码 4003 断开、立即从文档会话摘除（不再接收任何广播），客户端停止重连并退回首页
- **权限审计**：所有文档授权 / 工作区成员角色变更记录操作人、目标人、from/to、时间，
  在文档「成员权限」面板按时间线查看
- **实时协同编辑**：多人在线编辑同一文档，操作经 OT 变换后收敛一致
- **划词批注**：选中文字添加批注，支持回复、解决、删除；批注锚点随编辑自动移动
- **在线状态**：在线用户列表（按账号去重）、远程光标与选区实时展示
- **异常链路**：断网自动重连（指数退避）、离线编辑暂存、消息序号空洞检测、ack 超时重同步、版本过旧全量快照回滚

## 快速开始

```bash
npm run setup          # 安装根目录 + server + client 依赖
npm install            # 根目录 concurrently（dev 需要）
npm run dev            # server:8080 + vite:5173（/ws 与 /api 均已配置代理）
```

打开 http://localhost:5173 ，使用内置演示账号登录（密码均为 `demo1234`）：

| 账号 | 姓名 | 身份 |
| --- | --- | --- |
| `alice` | 林安 | 产品研发部管理员（对全部文档隐式「管理」） |
| `bob` | 王博文 | PRD 编辑、会议纪要编辑、季度规划批注 |
| `carol` | 陈晓艺 | PRD 批注；同时是「设计组」管理员 |
| `dave` | 戴伟 | PRD 查看、设计规范编辑 |

也可注册新账号（自动获得个人工作区）。多开标签页用不同账号进入同一文档，
再用管理员账号在右上角「成员权限」中在线调整角色，可直观看到对方被实时降权、在途编辑被拦截。

生产模式：

```bash
npm run build          # 构建客户端到 client/dist
npm start              # 服务端托管 API + 静态页面：http://localhost:8080
```

测试与类型检查：

```bash
npm test               # OT fuzz + 协同 e2e + 真实客户端集成 + 多租户权限 e2e（共 34 项）
npm run typecheck      # server tsc + client vue-tsc
```

## 多租户与权限模型

```
Account（账号：登录名/密码/令牌）
  └─ Membership（工作区成员：admin | member）  ── 多对多 ── Workspace（工作区）
                                                          └─ Doc（文档）
                                                               └─ DocPermission（账号 → viewer/commenter/editor/manager）
```

- **有效文档角色**：工作区 `admin` 对工作区内任意文档隐式为 `manager`；
  否则取文档级显式授权；都没有则**不可见、不可进入**。
- **进入流程**：客户端先调 `GET /api/workspaces/:wid/docs/:did/boot` 预加载角色（并记录最近访问），
  再用 WebSocket `join`（携带令牌、工作区、文档）由服务端做**权威鉴权**。
- **实时推送**：REST 改权成功后，服务端通过 `Hub`（userId ↔ 连接集 ↔ 文档会话）定位在线连接，
  更新会话角色、下发 `perm:update` 并广播 `presence`。

## REST API 摘要（均在 `/api` 前缀下，除登录/注册外需 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/register` `/auth/login` `/auth/logout` | 注册 / 登录 / 登出 |
| GET | `/auth/me` `/home` | 当前账号 / 首页聚合（工作区 + 最近协作） |
| GET/POST | `/workspaces` | 工作区列表 / 创建 |
| GET | `/workspaces/:wid` | 工作区详情（成员 + 可见文档目录） |
| POST | `/workspaces/:wid/members` | 按登录名添加成员（admin） |
| PUT/DELETE | `/workspaces/:wid/members/:uid` | 修改成员角色 / 移出工作区（级联收权并踢下线） |
| GET/POST | `/workspaces/:wid/docs` | 可见文档列表 / 创建文档（创建者为 manager） |
| GET | `/workspaces/:wid/docs/:did/boot` | 进入前权限预加载 |
| GET/PUT | `/workspaces/:wid/docs/:did/permissions` | 查看 / 配置成员权限（manager；body `{userId, role: Role\|null}`） |
| GET | `/workspaces/:wid/docs/:did/audit` | 该文档权限变更审计（manager） |

## 目录结构

```
├── shared/
│   ├── ot.ts             # OT 核心：apply / transformPair / compose / invert / mapPosition / diffToOp
│   ├── protocol.ts       # WS 协议：Role(四级) / Permission / 批注 / 全部 WS 消息（含 perm:update）
│   └── api.ts            # 多租户 REST 契约：账号/工作区/文档/权限/审计 类型
├── server/src/
│   ├── tenants.ts        # 多租户存储：账号·令牌·工作区·成员·文档权限·审计·最近访问（JSON 持久化 + 种子）
│   ├── hub.ts            # 会话注册表：userId↔WS 连接↔文档会话，在线改权推送 / 收权踢下线
│   ├── docSession.ts     # 文档会话：版本日志、OT、批注锚点、运行时改权、按账号去重 presence
│   ├── errors.ts         # ApiError（HTTP 状态码 + 稳定错误码）
│   └── index.ts          # REST API + WS 鉴权入口、心跳、静态托管、内容持久化
│   └── test/             # ot fuzz / e2e / otClient 集成 / tenant 多租户权限 e2e + helpers
└── client/src/
    ├── api.ts            # REST 客户端（令牌、错误处理）
    ├── collab/collab.ts  # 编排层：令牌加入、perm:update 降权回滚、收权退出、异常链路
    ├── ot/otClient.ts    # OT 客户端状态机（未确认队列 / 发送节流 / ack 超时）
    ├── ws/wsClient.ts    # WS 封装（自动重连；4001/4003 不重连；outbox 裁剪）
    ├── stores/           # auth（登录态）/ workspaces（目录）/ session（连接·动态角色）/ doc
    └── components/       # AuthGate / WorkspaceHome / MembersDialog / PermissionDialog
                          #   / TopBar / EditorView / AnnotationPanel
```

## 核心设计

### OT 并发模型

文档为纯字符串，操作是 `retain(n) / insert(s) / delete(n)` 组件序列：

- 服务端为每个文档维护 `revision` 与操作日志（上限 1000 条）。客户端操作携带基准版本号；
  若已落后，服务端将其对落后期间的全部已接受操作**逐个变换**后应用，再广播给其他人。
- 客户端本地乐观应用，未确认操作进入队列（`unacked[0]` 已发送待确认，其余为缓冲，
  连续输入经 `compose` 合并）。远程操作到达时与全部未确认操作做双侧变换。
- 同位置并发插入的先后由「先被服务端接受者优先」的全局约定打破，保证各端收敛。
- 正确性由 `server/test/ot.test.ts` 的随机 fuzz 性质测试保障。

### 在线改权与在途拦截的时序

```
管理员 PUT /permissions ──▶ TenantStore.setDocPermission（记审计、持久化）
                                    │
                                    ▼
                          Hub.pushDocRole（同一 Node 事件循环调用栈内）
             ┌──────────────────────┼────────────────────────┐
             ▼                      ▼                        ▼
   DocSession.setUserRole   向该用户全部连接发     （role=null）ws.close(4003)
   （后续校验读到新角色）     perm:update + 广播      并立即从会话摘除
```

由于 WS 消息在单线程内串行处理，降权推送返回前后续客户端消息不会被处理；
因此被降权者任何「在途」消息都在角色更新**之后**才进入 `receiveOp` 等校验点，必被拦截。
客户端收到降级推送后，若本地尚有未确认编辑（不可能再被接受），主动丢弃并请求全量快照回滚。

### 断网重连与消息可靠性

| 异常 | 检测 | 恢复 |
| --- | --- | --- |
| 断网 / 假死 | WS close、应用层 ping/pong（10s/5s） | 指数退避重连，重连带 `lastRevision` 重新 join（令牌鉴权） |
| 离线编辑 | — | 编辑进入 OT 队列、批注进入 outbox，重同步后自动补发（降权后越权消息被裁剪） |
| 消息丢失（下行） | 广播消息携带单调 `seq`，客户端检测空洞 | `resync`，服务端按版本补发 `ops`（按 opId 去重自己的操作） |
| 消息丢失（上行/ack） | ack 5s 超时 | 同上触发 resync |
| 版本过旧 / 降权冲突 | 日志不足 / 收到针对在途 op 的 PERMISSION_DENIED | 全量快照，客户端**回滚**未确认修改 |
| 权限/协议错误 | 服务端逐条校验返回 `error` | 前端提示，必要时自动 resync |
| 登录失效 / 权限收回 | close 4001 / 4003 | 停止自动重连，退回登录页 / 工作区首页 |

### 实时推送频率与持久化

- 编辑操作本地零延迟、发送端 60ms 节流合并；光标 120ms 节流且易失（不计 seq）。
- 文档内容变更 1.5s 防抖写盘（`server/data/doc-<ws>_<doc>.json`）；
  租户数据（账号/工作区/权限/审计）防抖写入 `server/data/tenants.json`。
- 服务端为单进程内存状态 + 文件持久化；多实例部署需引入共享存储与消息总线。

## 协议摘要

客户端 → 服务端：`join`（**token + workspaceId + docId** + lastRevision）/ `op` / `cursor` /
`ann:add|reply|resolve|delete` / `resync` / `ping`

服务端 → 客户端：`welcome`（含 userId/workspaceId/role）/ `ops` / `ack` / `op` /
`presence` / `cursor`（含 userId，`start=-1` 为光标墓碑）/ `ann:upsert|delete` /
`perm:update`（在线改权，role=null 表示收回）/ `error`（UNAUTHORIZED/FORBIDDEN/PERMISSION_DENIED…）/ `pong`
