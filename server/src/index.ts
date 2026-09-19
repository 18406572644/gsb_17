import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, normalize as normalizePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { DocSession, type ClientState } from './docSession'
import { TenantStore } from './store'
import { handleApi } from './api'
import type { ClientMsg, ServerMsg } from '../../shared/protocol'

const PORT = Number(process.env.PORT || 8080)
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data')
const CLIENT_DIST = join(ROOT, '..', 'client', 'dist')

const DEFAULT_DOC = `# 多人协同批注编辑器（演示文档）

本文档支持多人同时编辑与批注。你可以：

1. 以「管理」身份配置成员的查看 / 批注 / 编辑 / 管理权限，权限调整会实时生效；
2. 以「编辑」身份直接修改正文，所有修改通过 OT 算法实时合并；
3. 以「批注」身份选中文字后添加批注，批注锚点会随编辑自动移动；
4. 以「只读」身份旁观整个协作过程；
5. 被在线降权后，正在发送的编辑会被服务端立即拦截并回滚。

可使用演示账号登录：admin/admin123、editor/editor123、commenter/commenter123、viewer/viewer123。
`

/* ---------------- 租户数据 ---------------- */

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
const tenantStore = TenantStore.load(join(DATA_DIR, 'tenants.json'))

/* ---------------- 文档会话管理 + 持久化 ---------------- */

const sessions = new Map<string, DocSession>()
const persistTimers = new Map<string, NodeJS.Timeout>()

function dataFile(docId: string) {
  return join(DATA_DIR, `doc-${encodeURIComponent(docId)}.json`)
}

function schedulePersist(session: DocSession) {
  if (persistTimers.has(session.docId)) return
  persistTimers.set(
    session.docId,
    setTimeout(() => {
      persistTimers.delete(session.docId)
      try {
        writeFileSync(dataFile(session.docId), JSON.stringify(session.serialize(), null, 2))
      } catch (e) {
        console.error('[persist] 写入失败:', e)
      }
    }, 1500),
  )
}

function getSession(docId: string): DocSession {
  let s = sessions.get(docId)
  if (s) return s
  const file = dataFile(docId)
  if (existsSync(file)) {
    try {
      s = DocSession.deserialize(JSON.parse(readFileSync(file, 'utf8')))
      console.log(`[doc] 从磁盘恢复文档 ${docId} (rev=${s.revision})`)
    } catch (e) {
      console.error('[doc] 恢复失败，使用空文档:', e)
      s = new DocSession(docId, '')
    }
  } else {
    s = new DocSession(docId, docId === 'demo' ? DEFAULT_DOC : '')
  }
  s.onDirty = () => schedulePersist(s!)
  sessions.set(docId, s)
  return s
}

/* ---------------- 实时权限变更 → 在线连接 ---------------- */

tenantStore.onPermissionChange = ({ docId, workspaceId, userId, role }) => {
  const session = sessions.get(docId)
  if (!session) return
  if (role === null) {
    // 被移出文档或工作区：强制下线该用户的全部连接
    const removed = session.removeUser(userId)
    if (removed.length) {
      for (const c of removed) {
        c.send({ type: 'doc:closed', docId, reason: '你已被移出该文档' } satisfies ServerMsg)
        invalidateConn.get(c.clientId)?.()
      }
      session.broadcastAll({ type: 'presence', users: session.users() })
      console.log(`[perm] ${userId} 被移出文档 ${docId}，已断开 ${removed.length} 个连接`)
    }
    return
  }
  // 重新解析有效角色：显式文档授权优先，工作区管理员始终隐式拥有管理权
  const effective = tenantStore.resolveDocRole(docId, userId)
  if (!effective) {
    // 兜底：权限记录异常缺失时强制下线
    const removed = session.removeUser(userId)
    for (const c of removed) {
      c.send({ type: 'doc:closed', docId, reason: '你的文档访问权限已失效' } satisfies ServerMsg)
      invalidateConn.get(c.clientId)?.()
    }
    session.broadcastAll({ type: 'presence', users: session.users() })
    return
  }
  const affected = session.updateUserRole(userId, effective)
  if (!affected.length) return
  for (const c of affected) {
    c.send({
      type: 'perm:changed',
      docId,
      role: effective,
      message: `你的文档权限已变更为「${effective}」`,
    } satisfies ServerMsg)
  }
  // 角色标签也会随 presence 更新
  session.broadcastAll({ type: 'presence', users: session.users() })
  console.log(`[perm] ${userId} 在文档 ${docId} 的权限变更为 ${effective}（${workspaceId}），在线 ${affected.length} 连接`)
}

tenantStore.onDocDelete = ({ docId }) => {
  const session = sessions.get(docId)
  if (!session) return
  for (const c of [...session.clients.values()]) {
    c.send({ type: 'doc:closed', docId, reason: '文档已被管理员删除' } satisfies ServerMsg)
    invalidateConn.get(c.clientId)?.()
  }
  session.clients.clear()
  sessions.delete(docId)
}

/* ---------------- HTTP：API + 健康检查 + 生产模式静态托管 ---------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, docs: sessions.size }))
    return
  }

  // REST API（多租户 / 权限 / 审计）
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, tenantStore)
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

/** clientId → 连接，用于心跳清理 */
const alive = new Map<string, WebSocket>()
/** clientId → 连接失效回调（被移出文档/工作区后使该连接脱离旧会话，防止沿旧引用继续操作） */
const invalidateConn = new Map<string, () => void>()

wss.on('connection', (ws: WebSocket) => {
  const connId = randomUUID()
  alive.set(connId, ws)

  let session: DocSession | null = null
  let client: ClientState | null = null

  // 被移出文档/工作区时注销该连接的会话引用（旧闭包不能再操作任何文档）
  invalidateConn.set(connId, () => {
    session = null
    client = null
  })

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
          // 身份与权限完全由服务端根据令牌解析，忽略客户端自选角色
          let resolved: { docId: string; workspaceId: string; role: ClientState['role']; name: string }
          let user: { id: string; displayName: string }
          try {
            const u = tenantStore.userFromToken(msg.token || '')
            const r = tenantStore.resolveDocForUser(msg.docId || 'demo', u.id)
            resolved = {
              docId: r.doc.id,
              workspaceId: r.doc.workspaceId,
              role: r.role,
              name: u.displayName,
            }
            user = u
            tenantStore.touchRecent(u.id, r.doc.id)
          } catch (e) {
            const known = new Set(['PERMISSION_DENIED', 'UNAUTHENTICATED', 'NOT_FOUND'])
            const code = known.has((e as { code?: string }).code || '')
              ? ((e as { code: 'PERMISSION_DENIED' | 'UNAUTHENTICATED' | 'NOT_FOUND' }).code)
              : 'UNAUTHENTICATED'
            send({
              type: 'error',
              code,
              message: (e as Error).message || '无权进入该文档',
            })
            // 重复 join 被拒：摘除旧会话引用，该连接不能再沿旧身份操作原文档
            if (session && client) {
              session.removeClient(client.clientId)
              session.broadcastAll({ type: 'presence', users: session.users() })
              session = null
              client = null
            }
            return
          }

          // 重复 join：先清理旧会话
          if (session && client) {
            session.removeClient(client.clientId)
            session.broadcastAll({ type: 'presence', users: session.users() })
          }
          session = getSession(resolved.docId)
          client = session.addClient(connId, user.id, resolved.name, resolved.role, send)
          const lastRevision = typeof msg.lastRevision === 'number' ? msg.lastRevision : -1
          const resync = session.buildResync(lastRevision)
          const welcomeBase = {
            clientId: connId,
            userId: user.id,
            docId: session.docId,
            workspaceId: resolved.workspaceId,
            revision: session.revision,
            annotations: [...session.annotations.values()],
            users: session.users(),
            role: client.role,
          }
          if (resync.kind === 'ops') {
            // 增量补齐：welcome 不带文档（客户端保留本地文档），随后补发错过的操作流
            send({
              type: 'welcome',
              ...welcomeBase,
              doc: '',
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
              ...welcomeBase,
              doc: session.doc,
              snapshot: true,
              seq: session.seq,
            } satisfies ServerMsg)
          }
          session.broadcastAll({ type: 'presence', users: session.users() })
          console.log(`[join] ${client.name} (${client.role}) → ${session.docId}，在线 ${session.clients.size} 人`)
          break
        }

        case 'op': {
          if (!session || !client) return
          // 在途操作拦截：角色可能已被管理员在线调整，receiveOp 内部以最新角色再校验
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
              userId: client.userId,
              docId: session.docId,
              workspaceId: tenantStore.requireDoc(session.docId).workspaceId,
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
    invalidateConn.delete(connId)
    if (session && client) {
      session.removeClient(client.clientId)
      session.broadcastAll({ type: 'presence', users: session.users() })
      console.log(`[leave] ${client.name} 离开 ${session.docId}，在线 ${session.clients.size} 人`)
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
  console.log(`[server] HTTP + WebSocket 已启动: http://localhost:${PORT} (ws: /ws, api: /api)`)
})

function shutdown() {
  clearInterval(heartbeat)
  for (const ws of alive.values()) ws.terminate()
  alive.clear()
  invalidateConn.clear()
  for (const t of persistTimers.values()) clearTimeout(t)
  tenantStore.flush()
  wss.close()
  server.close()
}

export { server, getSession, tenantStore, shutdown }
