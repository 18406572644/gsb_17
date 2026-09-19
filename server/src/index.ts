import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, normalize as normalizePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { DocSession, type ClientState } from './docSession'
import { Hub, CLOSE_REVOKED } from './hub'
import { TenantStore } from './tenants'
import { ApiError } from './errors'
import type { ClientMsg, ServerMsg } from '../../shared/protocol'
import type {
  AddMemberRequest,
  CreateDocRequest,
  CreateWorkspaceRequest,
  LoginRequest,
  RegisterRequest,
  SetDocPermissionRequest,
  UpdateMemberRoleRequest,
} from '../../shared/api'

const PORT = Number(process.env.PORT || 8080)
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data')
const CLIENT_DIST = join(ROOT, '..', 'client', 'dist')

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

/* ---------------- 多租户存储 + 会话注册表 ---------------- */

const tenants = new TenantStore(join(DATA_DIR, 'tenants.json'))
tenants.bootstrap()

const hub = new Hub()

/* ---------------- 文档会话管理 + 内容持久化 ---------------- */

const sessions = new Map<string, DocSession>()
const persistTimers = new Map<string, NodeJS.Timeout>()

function sessionKey(workspaceId: string, docId: string) {
  return `${workspaceId}/${docId}`
}

function contentFile(key: string) {
  // workspaceId / docId 均为 UUID（仅含十六进制与连字符），直接拼文件名
  return join(DATA_DIR, `doc-${key.replace(/\//g, '_')}.json`)
}

function schedulePersist(key: string, session: DocSession) {
  if (persistTimers.has(key)) return
  persistTimers.set(
    key,
    setTimeout(() => {
      persistTimers.delete(key)
      try {
        writeFileSync(contentFile(key), JSON.stringify(session.serialize(), null, 2))
      } catch (e) {
        console.error('[persist] 写入失败:', e)
      }
    }, 1500),
  )
}

function getSession(workspaceId: string, docId: string): DocSession {
  const key = sessionKey(workspaceId, docId)
  let s = sessions.get(key)
  if (s) return s
  const file = contentFile(key)
  if (existsSync(file)) {
    try {
      s = DocSession.deserialize(JSON.parse(readFileSync(file, 'utf8')))
      console.log(`[doc] 从磁盘恢复 ${key} (rev=${s.revision})`)
    } catch (e) {
      console.error('[doc] 恢复失败，使用空文档:', e)
      s = new DocSession(docId, '')
    }
  } else {
    // 全新文档：使用首次播种的初始内容（若有），否则空文档
    const seed = tenants.seedContent.get(docId)?.content
    s = new DocSession(docId, seed ?? '')
  }
  s.onDirty = () => {
    schedulePersist(key, s!)
    tenants.markDocActivity(workspaceId, docId)
  }
  sessions.set(key, s)
  return s
}

// 全新播种的文档内容立即落盘，避免「播种后、首次打开前重启」导致初始内容丢失
for (const [docId, { workspaceId }] of tenants.seedContent) {
  const key = sessionKey(workspaceId, docId)
  const s = getSession(workspaceId, docId)
  writeFileSync(contentFile(key), JSON.stringify(s.serialize(), null, 2))
  void s
}
tenants.seedContent.clear()

/* ---------------- HTTP 工具 ---------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1_000_000) {
        reject(ApiError.bad('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(ApiError.bad('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 从 Authorization 头解析当前账号 */
function authenticate(req: IncomingMessage) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) throw ApiError.unauthorized()
  return tenants.requireUser(token)
}

/* ---------------- REST API ---------------- */

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname
  const method = req.method || 'GET'
  const parts = p.split('/').filter(Boolean) // ['api', ...]

  // 无需鉴权
  if (p === '/api/auth/login' && method === 'POST') {
    const body = (await readBody(req)) as LoginRequest
    const { token, userId } = tenants.login(body.username || '', body.password || '')
    return sendJson(res, 200, { token, account: tenants.toAccount(tenants.requireAccount(userId)) }), true
  }
  if (p === '/api/auth/register' && method === 'POST') {
    const body = (await readBody(req)) as RegisterRequest
    const { token, userId } = tenants.register(body.username || '', body.password || '', body.name || '')
    return sendJson(res, 200, { token, account: tenants.toAccount(tenants.requireAccount(userId)) }), true
  }

  // 以下全部需要登录
  const account = authenticate(req)

  if (p === '/api/auth/logout' && method === 'POST') {
    const token = (req.headers.authorization || '').slice(7).trim()
    tenants.logout(token)
    return sendJson(res, 200, { ok: true }), true
  }
  if (p === '/api/auth/me' && method === 'GET') {
    return sendJson(res, 200, { account: tenants.toAccount(account) }), true
  }

  if (p === '/api/home' && method === 'GET') {
    const workspaces = tenants.listWorkspacesFor(account.id).map((w) => tenants.toWorkspaceView(w, account.id))
    const recent = tenants.listRecent(account.id).map(({ rec, doc, role }) => ({
      doc: tenants.toDocMeta(doc, role),
      lastVisitedAt: rec.lastVisitedAt,
    }))
    return sendJson(res, 200, { account: tenants.toAccount(account), workspaces, recent }), true
  }

  if (p === '/api/workspaces' && method === 'GET') {
    const list = tenants.listWorkspacesFor(account.id).map((w) => tenants.toWorkspaceView(w, account.id))
    return sendJson(res, 200, list), true
  }
  if (p === '/api/workspaces' && method === 'POST') {
    const body = (await readBody(req)) as CreateWorkspaceRequest
    const ws = tenants.createWorkspace(account.id, body.name || '')
    return sendJson(res, 201, tenants.toWorkspaceView(ws, account.id)), true
  }

  // /api/workspaces/:wid/...
  const wid = parts[2]
  if (parts[1] === 'workspaces' && wid) {
    // 工作区详情
    if (parts.length === 3 && method === 'GET') {
      tenants.requireMember(wid, account.id)
      const ws = tenants.getWorkspace(wid)
      const members = tenants.listMembers(wid).map(({ membership: m, account: a }) => ({
        userId: a.id,
        name: a.name,
        username: a.username,
        color: a.color,
        role: m.role,
      }))
      const docs = tenants.listAccessibleDocs(account.id, wid).map((d) =>
        tenants.toDocMeta(d, tenants.effectiveDocRole(wid, d.id, account.id)!),
      )
      return (
        sendJson(res, 200, { workspace: tenants.toWorkspaceView(ws, account.id), members, docs }), true
      )
    }

    // 成员管理
    if (parts.length === 4 && parts[3] === 'members' && method === 'POST') {
      const body = (await readBody(req)) as AddMemberRequest
      tenants.addMember(account.id, wid, body.username || '', body.role)
      return sendJson(res, 200, { ok: true }), true
    }
    const memberMatch = parts.length === 5 && parts[3] === 'members'
    const targetUid = parts[4]
    if (memberMatch && method === 'PUT') {
      const body = (await readBody(req)) as UpdateMemberRoleRequest
      const { changes } = tenants.updateMemberRole(account.id, wid, targetUid, body.role)
      // 工作区角色变化联动各文档的有效权限（如 admin 降为 member → 失去隐式 manager）
      for (const ch of changes) {
        hub.pushDocRole(targetUid, wid, ch.docId, ch.toRole, account.name)
      }
      return sendJson(res, 200, { ok: true }), true
    }
    if (memberMatch && method === 'DELETE') {
      const removed = tenants.removeMember(account.id, wid, targetUid)
      hub.evictFromWorkspace(targetUid, wid, account.name)
      return sendJson(res, 200, { ok: true, affectedDocs: removed }), true
    }

    // 文档创建 / 列表
    if (parts.length === 4 && parts[3] === 'docs' && method === 'POST') {
      const body = (await readBody(req)) as CreateDocRequest
      const doc = tenants.createDoc(account.id, wid, body.title || '')
      return sendJson(res, 201, tenants.toDocMeta(doc, 'manager')), true
    }
    if (parts.length === 4 && parts[3] === 'docs' && method === 'GET') {
      const docs = tenants.listAccessibleDocs(account.id, wid).map((d) =>
        tenants.toDocMeta(d, tenants.effectiveDocRole(wid, d.id, account.id)!),
      )
      return sendJson(res, 200, docs), true
    }

    // 文档子资源
    const did = parts[4]
    if (parts[3] === 'docs' && did) {
      const sub = parts[5]
      if (parts.length === 6 && sub === 'boot' && method === 'GET') {
        const { doc, role } = tenants.requireDocAccess(account.id, wid, decodeURIComponent(did))
        tenants.touchRecent(account.id, wid, doc.id)
        const key = sessionKey(wid, doc.id)
        const live = sessions.get(key)
        const onlineUsers = live
          ? live.users().map((u) => ({ userId: u.userId, name: u.name, color: u.color, role: u.role }))
          : []
        return (
          sendJson(res, 200, {
            doc: tenants.toDocMeta(doc, role),
            role,
            workspaceId: wid,
            onlineUsers,
          }),
          true
        )
      }
      if (parts.length === 6 && sub === 'permissions' && method === 'GET') {
        return sendJson(res, 200, tenants.docPermissionView(account.id, wid, decodeURIComponent(did))), true
      }
      if (parts.length === 6 && sub === 'permissions' && method === 'PUT') {
        const body = (await readBody(req)) as SetDocPermissionRequest
        const docId = decodeURIComponent(did)
        const change = tenants.setDocPermission(
          account.id,
          wid,
          docId,
          body.userId,
          body.role ?? null,
        )
        // 实时通知：被调整者若正在编辑该文档，立即生效 / 踢下线
        hub.pushDocRole(change.targetUserId, wid, docId, change.toRole, account.name)
        return sendJson(res, 200, { ok: true, ...change }), true
      }
      if (parts.length === 6 && sub === 'audit' && method === 'GET') {
        return sendJson(res, 200, tenants.listDocAudit(account.id, wid, decodeURIComponent(did))), true
      }
    }
  }

  return false
}

/* ---------------- HTTP 服务 ---------------- */

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, docs: sessions.size, onlineUsers: hub.onlineUserCount() }))
    return
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await handleApi(req, res, url)
      if (!handled) sendJson(res, 404, { error: 'NOT_FOUND', message: '接口不存在' })
    } catch (e) {
      if (e instanceof ApiError) {
        sendJson(res, e.status, { error: e.code, message: e.message })
      } else {
        console.error('[api] 处理异常:', e)
        sendJson(res, 500, { error: 'INTERNAL', message: '服务器内部错误' })
      }
    }
    return
  }

  // 生产模式：托管 client/dist
  let path = normalizePath(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  if (path === '/' || path === '\\') path = '/index.html'
  const file = join(CLIENT_DIST, path)
  if (existsSync(file) && file.startsWith(CLIENT_DIST)) {
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
    return
  }
  // SPA 回退
  const index = join(CLIENT_DIST, 'index.html')
  if (existsSync(index)) {
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(readFileSync(index))
    return
  }
  res.writeHead(404)
  res.end('client 未构建：请先运行 npm --prefix client run build，或使用 vite dev 模式')
})

/* ---------------- WebSocket ---------------- */

const wss = new WebSocketServer({ server, path: '/ws' })

/** connId → 连接，用于心跳清理 */
const alive = new Map<string, WebSocket>()

wss.on('connection', (ws: WebSocket) => {
  const connId = randomUUID()
  alive.set(connId, ws)

  let session: DocSession | null = null
  let client: ClientState | null = null
  let workspaceId = ''
  let userId = ''

  const send = (msg: ServerMsg | object) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  ws.on('pong', () => alive.set(connId, ws))

  ws.on('message', (raw) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      send({ type: 'error', code: 'BAD_MESSAGE', message: '消息不是合法 JSON' })
      return
    }

    try {
      switch (msg.type) {
        case 'join': {
          // 身份解析 + 文档鉴权（进入编辑器前权限已由 REST boot 预加载，此处为权威校验）
          let account
          let access
          try {
            account = tenants.requireUser(msg.token || '')
            access = tenants.requireDocAccess(account.id, msg.workspaceId, msg.docId)
          } catch (e) {
            if (e instanceof ApiError) {
              send({ type: 'error', code: e.code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : 'FORBIDDEN', message: e.message })
              ws.close(e.code === 'UNAUTHORIZED' ? 4001 : CLOSE_REVOKED, e.message)
            } else {
              send({ type: 'error', code: 'INTERNAL', message: '加入失败' })
            }
            return
          }

          // 重复 join（同连接切换/重加入）：先摘除旧绑定
          const old = hub.get(connId)
          if (old?.binding) {
            const b = hub.unregister(connId)
            b?.session.broadcastAll({ type: 'presence', users: b.session.users() })
          }

          workspaceId = msg.workspaceId
          userId = account.id
          session = getSession(access.doc.workspaceId, access.doc.id)
          if (!hub.get(connId)) hub.register(connId, account.id, ws, send)
          client = session.addClient({
            clientId: connId,
            userId: account.id,
            name: account.name,
            role: access.role,
            color: account.color,
            send,
          })
          hub.bind(connId, { workspaceId: access.doc.workspaceId, docId: access.doc.id, session })
          tenants.touchRecent(account.id, access.doc.workspaceId, access.doc.id)

          const lastRevision = typeof msg.lastRevision === 'number' ? msg.lastRevision : -1
          const resync = session.buildResync(lastRevision)
          if (resync.kind === 'ops') {
            // 增量补齐：welcome 不带文档（客户端保留本地文档），随后补发错过的操作流
            send({
              type: 'welcome',
              clientId: connId,
              userId: account.id,
              workspaceId: access.doc.workspaceId,
              docId: access.doc.id,
              revision: session.revision,
              doc: '',
              annotations: [...session.annotations.values()],
              users: session.users(),
              role: client.role,
              snapshot: false,
              seq: session.seq,
            } satisfies ServerMsg)
            session.seq++
            send({
              type: 'ops',
              ops: resync.ops.map((e) => ({
                revision: e.revision,
                op: e.op,
                opId: e.opId,
                clientId: e.clientId,
                authorName: e.authorName,
              })),
              revision: session.revision,
              seq: session.seq,
            } satisfies ServerMsg)
          } else {
            send({
              type: 'welcome',
              clientId: connId,
              userId: account.id,
              workspaceId: access.doc.workspaceId,
              docId: access.doc.id,
              revision: session.revision,
              doc: session.doc,
              annotations: [...session.annotations.values()],
              users: session.users(),
              role: client.role,
              snapshot: true,
              seq: session.seq,
            } satisfies ServerMsg)
          }
          session.broadcastAll({ type: 'presence', users: session.users() })
          console.log(
            `[join] ${account.name} (${client.role}) → ${access.doc.workspaceId}/${access.doc.id}，在线 ${session.clients.size} 连接`,
          )
          break
        }

        case 'op': {
          if (!session || !client) return
          const err = session.receiveOp(client, msg.revision, msg.op, msg.opId)
          if (err) send({ type: 'error', code: err.code, message: err.message, opId: msg.opId })
          break
        }

        case 'cursor': {
          if (!session || !client) return
          session.updateCursor(client, msg.start, msg.end)
          break
        }

        case 'ann:add': {
          if (!session || !client) return
          const err = session.addAnnotation(client, msg)
          if (err) send({ type: 'error', code: err.code, message: err.message })
          break
        }

        case 'ann:reply': {
          if (!session || !client) return
          const err = session.replyAnnotation(client, msg)
          if (err) send({ type: 'error', code: err.code, message: err.message })
          break
        }

        case 'ann:resolve': {
          if (!session || !client) return
          const err = session.resolveAnnotation(client, msg)
          if (err) send({ type: 'error', code: err.code, message: err.message })
          break
        }

        case 'ann:delete': {
          if (!session || !client) return
          const err = session.deleteAnnotation(client, msg.annId)
          if (err) send({ type: 'error', code: err.code, message: err.message })
          break
        }

        case 'resync': {
          if (!session || !client) return
          const resync = session.buildResync(msg.lastRevision)
          if (resync.kind === 'ops') {
            session.seq++
            send({
              type: 'ops',
              ops: resync.ops.map((e) => ({
                revision: e.revision,
                op: e.op,
                opId: e.opId,
                clientId: e.clientId,
                authorName: e.authorName,
              })),
              revision: session.revision,
              seq: session.seq,
            } satisfies ServerMsg)
          } else {
            // 全量快照：客户端丢弃本地未确认修改并回滚
            send({
              type: 'welcome',
              clientId: connId,
              userId,
              workspaceId,
              docId: session.docId,
              revision: session.revision,
              doc: session.doc,
              annotations: [...session.annotations.values()],
              users: session.users(),
              role: client.role,
              snapshot: true,
              seq: session.seq,
            } satisfies ServerMsg)
          }
          break
        }

        case 'ping': {
          send({ type: 'pong', t: msg.t })
          break
        }
      }
    } catch (e) {
      console.error('[ws] 处理消息异常:', e)
      send({ type: 'error', code: 'INTERNAL', message: '服务器内部错误，请重新同步' })
    }
  })

  ws.on('close', () => {
    alive.delete(connId)
    const binding = hub.unregister(connId)
    if (binding) {
      binding.session.broadcastAll({ type: 'presence', users: binding.session.users() })
      console.log(`[leave] 连接 ${connId} 离开，文档在线 ${binding.session.clients.size} 连接`)
    }
  })

  ws.on('error', () => ws.close())
})

/** 心跳：30 秒未响应的连接判定死亡并断开（触发客户端重连逻辑） */
const heartbeat = setInterval(() => {
  for (const [id, ws] of alive) {
    if ((ws as unknown as { isAlive?: boolean }).isAlive === false) {
      alive.delete(id)
      ws.terminate()
      continue
    }
    ;(ws as unknown as { isAlive?: boolean }).isAlive = false
    ws.ping()
    ws.once('pong', () => {
      ;(ws as unknown as { isAlive?: boolean }).isAlive = true
    })
  }
}, 30_000)

wss.on('close', () => clearInterval(heartbeat))

server.listen(PORT, () => {
  console.log(`[server] HTTP + WebSocket 已启动: http://localhost:${PORT} (ws: /ws)`)
})

export function shutdown() {
  clearInterval(heartbeat)
  for (const ws of alive.values()) ws.terminate()
  alive.clear()
  for (const t of persistTimers.values()) clearTimeout(t)
  tenants.shutdown()
  wss.close()
  server.close()
}

export { server, getSession, tenants, hub }
