/**
 * HTTP REST API：认证、工作区、文档目录、文档成员细粒度权限、审计、最近协作。
 * 挂载在 /api 前缀下；返回 true 表示请求已被处理。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { permissionOf, type DocRole } from '../../shared/tenant'
import type { User } from '../../shared/tenant'
import { ApiError, TenantStore } from './store'

const MAX_BODY = 64 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'BAD_REQUEST', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new ApiError(400, 'BAD_MESSAGE', '请求体不是合法 JSON'))
      }
    })
    req.on('error', () => reject(new ApiError(400, 'BAD_MESSAGE', '读取请求体失败')))
  })
}

/** 从 Authorization 头解析当前用户；optional=true 时缺失不报错 */
function authenticate(store: TenantStore, req: IncomingMessage, optional = false): User | null {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) {
    if (optional) return null
    throw new ApiError(401, 'UNAUTHENTICATED', '未登录')
  }
  return store.userFromToken(token)
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { store: TenantStore; user: User | null; body: any; params: string[]; query: URLSearchParams },
) => void | Promise<void>

interface Route {
  method: string
  /** 形如 /api/workspaces/_/docs，_ 匹配一段 */
  segments: string[]
  auth: boolean
  handler: Handler
}

function route(method: string, path: string, auth: boolean, handler: Handler): Route {
  return { method, segments: path.split('/').filter(Boolean), auth, handler }
}

const routes: Route[] = [
  /* 认证 */
  route('POST', '/api/auth/register', false, (_req, res, { store, body }) => {
    store.register(body.username, body.password, body.displayName)
    sendJson(res, 201, store.login(body.username.trim(), body.password))
  }),
  route('POST', '/api/auth/login', false, (_req, res, { store, body }) => {
    sendJson(res, 200, store.login(body.username, body.password))
  }),
  route('POST', '/api/auth/logout', true, (req, res, { store }) => {
    const header = req.headers.authorization || ''
    if (header.startsWith('Bearer ')) store.logout(header.slice(7))
    sendJson(res, 200, { ok: true })
  }),
  route('GET', '/api/me', true, (_req, res, { user }) => {
    sendJson(res, 200, { user })
  }),

  /* 最近协作 */
  route('GET', '/api/recent', true, (_req, res, { store, user }) => {
    sendJson(res, 200, { recent: store.listRecent(user!.id) })
  }),

  /* 工作区 */
  route('GET', '/api/workspaces', true, (_req, res, { store, user }) => {
    sendJson(res, 200, { workspaces: store.listWorkspaces(user!.id) })
  }),
  route('POST', '/api/workspaces', true, async (_req, res, { store, user, body }) => {
    const ws = store.createWorkspace(user!.id, body.name || '', body.description)
    sendJson(res, 201, { workspace: ws })
  }),
  route('GET', '/api/workspaces/_', true, (_req, res, { store, user, params }) => {
    sendJson(res, 200, store.getWorkspaceDetail(user!.id, params[0]))
  }),
  route('POST', '/api/workspaces/_/members', true, async (_req, res, { store, user, body, params }) => {
    const member = store.addWorkspaceMember(user!.id, params[0], body.username, body.role || 'member')
    sendJson(res, 201, { member })
  }),
  route('PATCH', '/api/workspaces/_/members/_', true, async (_req, res, { store, user, body, params }) => {
    store.updateWorkspaceMember(user!.id, params[0], params[1], body.role)
    sendJson(res, 200, { ok: true })
  }),
  route('DELETE', '/api/workspaces/_/members/_', true, (_req, res, { store, user, params }) => {
    store.removeWorkspaceMember(user!.id, params[0], params[1])
    sendJson(res, 200, { ok: true })
  }),

  /* 文档目录 */
  route('GET', '/api/workspaces/_/docs', true, (_req, res, { store, user, params }) => {
    sendJson(res, 200, { docs: store.listDocs(params[0], user!.id) })
  }),
  route('POST', '/api/workspaces/_/docs', true, async (_req, res, { store, user, body, params }) => {
    const doc = store.createDoc(user!.id, params[0], body.title || '')
    sendJson(res, 201, { doc })
  }),
  route('GET', '/api/workspaces/_/audit', true, (_req, res, { store, user, params, query }) => {
    const limit = Math.min(200, Number(query.get('limit')) || 100)
    sendJson(res, 200, { entries: store.listAudit(user!.id, params[0], undefined, limit) })
  }),

  /* 单个文档 */
  route('GET', '/api/docs/_', true, (_req, res, { store, user, params }) => {
    const { doc, role } = store.resolveDocForUser(params[0], user!.id)
    const workspace = store.getWorkspaceDetail(user!.id, doc.workspaceId).workspace
    sendJson(res, 200, {
      doc,
      workspace,
      role,
      permission: permissionOf(role),
      members: store.listDocMembers(doc.id, user!.id),
    })
  }),
  route('PATCH', '/api/docs/_', true, async (_req, res, { store, user, body, params }) => {
    sendJson(res, 200, { doc: store.renameDoc(user!.id, params[0], body.title || '') })
  }),
  route('DELETE', '/api/docs/_', true, (_req, res, { store, user, params }) => {
    store.deleteDoc(user!.id, params[0])
    sendJson(res, 200, { ok: true })
  }),
  route('POST', '/api/docs/_/opened', true, (_req, res, { store, user, params }) => {
    // 进入编辑器时记录最近协作（需有访问权）
    store.resolveDocForUser(params[0], user!.id)
    store.touchRecent(user!.id, params[0])
    sendJson(res, 200, { ok: true })
  }),

  /* 文档成员与细粒度权限 */
  route('GET', '/api/docs/_/members', true, (_req, res, { store, user, params }) => {
    sendJson(res, 200, { members: store.listDocMembers(params[0], user!.id) })
  }),
  route('PUT', '/api/docs/_/members', true, async (_req, res, { store, user, body, params }) => {
    const role: DocRole = body.role
    if (!['viewer', 'commenter', 'editor', 'admin'].includes(role)) {
      throw new ApiError(400, 'BAD_REQUEST', '角色无效')
    }
    const member = store.grantDocMember(user!.id, params[0], body.username, role)
    sendJson(res, 200, { member })
  }),
  route('DELETE', '/api/docs/_/members/_', true, (_req, res, { store, user, params }) => {
    store.revokeDocMember(user!.id, params[0], params[1])
    sendJson(res, 200, { ok: true })
  }),

  /* 审计 */
  route('GET', '/api/docs/_/audit', true, (_req, res, { store, user, params, query }) => {
    const limit = Math.min(200, Number(query.get('limit')) || 100)
    sendJson(res, 200, { entries: store.listAudit(user!.id, store.requireDoc(params[0]).workspaceId, params[0], limit) })
  }),
]

function matchRoute(method: string, pathname: string): { route: Route; params: string[] } | null {
  const segs = pathname.split('/').filter(Boolean)
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== segs.length) continue
    const params: string[] = []
    let ok = true
    for (let i = 0; i < segs.length; i++) {
      if (route.segments[i] === '_') params.push(decodeURIComponent(segs[i]))
      else if (route.segments[i] !== segs[i]) {
        ok = false
        break
      }
    }
    if (ok) return { route, params }
  }
  return null
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: TenantStore,
): Promise<boolean> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (!url.pathname.startsWith('/api/')) return false

  const matched = matchRoute(req.method || 'GET', url.pathname)
  if (!matched) {
    sendJson(res, 404, { error: 'NOT_FOUND', message: '接口不存在' })
    return true
  }

  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readBody(req) : {}
    const user = authenticate(store, req, !matched.route.auth)
    if (matched.route.auth && !user) throw new ApiError(401, 'UNAUTHENTICATED', '未登录')
    await matched.route.handler(req, res, { store, user, body, params: matched.params, query: url.searchParams })
  } catch (e) {
    if (e instanceof ApiError) {
      sendJson(res, e.status, { error: e.code, message: e.message })
    } else {
      console.error('[api] 处理异常:', e)
      sendJson(res, 500, { error: 'INTERNAL', message: '服务器内部错误' })
    }
  }
  return true
}
