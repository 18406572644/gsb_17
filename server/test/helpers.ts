/**
 * 多租户端到端测试辅助：REST 建租户/工作区/文档/授权 + 携带令牌的 WS 客户端。
 */
import WebSocket from 'ws'
import type { ServerMsg, WelcomeMsg } from '../../shared/protocol'
import type { Role } from '../../shared/protocol'

export interface Creds {
  token: string
  userId: string
  name: string
  username: string
}

export class RestClient {
  constructor(private base: string, readonly token = '') {}

  async call<T = any>(method: string, path: string, body?: unknown, token = this.token): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status}: ${data?.message || res.statusText}`)
      ;(err as any).status = res.status
      ;(err as any).code = data?.error
      throw err
    }
    return data as T
  }
}

let seq = 0
function uname(prefix: string) {
  seq += 1
  return `${prefix}${Date.now().toString(36)}${seq}${Math.floor(Math.random() * 1e4)}`
}

/** 注册一个全新账号并返回凭据 */
export async function registerUser(
  rest: RestClient,
  prefix = 'u',
): Promise<Creds> {
  const username = uname(prefix).slice(0, 20).replace(/[^a-z0-9_]/g, 'x')
  const name = `${prefix}-${seq}`
  const res = await rest.call<{ token: string; account: { id: string; name: string; username: string } }>(
    'POST',
    '/api/auth/register',
    { username, password: 'secret123', name },
  )
  return { token: res.token, userId: res.account.id, name: res.account.name, username }
}

export interface Scenario {
  rest: RestClient
  workspaceId: string
  docId: string
  docTitle: string
  admin: Creds
  members: Record<string, Creds>
  /** 设置某成员对本文档的权限（null 收回） */
  grant: (user: Creds, role: Role | null) => Promise<any>
  permissions: () => Promise<any>
}

/**
 * 搭建隔离场景：admin 建工作区与文档；member 账号被加入工作区（默认无文档权限）。
 * 可按需 grant 角色。
 */
export async function setupScenario(base: string): Promise<Scenario> {
  const rest = new RestClient(base)
  const admin = await registerUser(rest, 'adm')
  const m1 = await registerUser(rest, 'usr')
  const m2 = await registerUser(rest, 'usr')
  const m3 = await registerUser(rest, 'usr')
  const members = { m1, m2, m3 }

  const ws = await rest.call<{ id: string }>('POST', '/api/workspaces', { name: `WS-${seq}` }, admin.token)
  const workspaceId = ws.id
  for (const m of [m1, m2, m3]) {
    await rest.call('POST', `/api/workspaces/${workspaceId}/members`, { username: m.username, role: 'member' }, admin.token)
  }
  const doc = await rest.call<{ id: string; title: string }>(
    'POST',
    `/api/workspaces/${workspaceId}/docs`,
    { title: `Doc-${seq}` },
    admin.token,
  )

  const grant = (user: Creds, role: Role | null) =>
    rest.call(
      'PUT',
      `/api/workspaces/${workspaceId}/docs/${doc.id}/permissions`,
      { userId: user.userId, role },
      admin.token,
    )
  const permissions = () =>
    rest.call('GET', `/api/workspaces/${workspaceId}/docs/${doc.id}/permissions`, undefined, admin.token)

  return {
    rest,
    workspaceId,
    docId: doc.id,
    docTitle: doc.title,
    admin,
    members,
    grant,
    permissions,
  }
}

/** 携带令牌加入文档的 WS 测试客户端（含基础 OT 处理） */
export class AuthTestClient {
  ws: WebSocket
  clientId = ''
  userId = ''
  doc = ''
  revision = 0
  role: Role | null = null
  inbox: ServerMsg[] = []
  private waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []

  constructor(
    private url: string,
    readonly creds: Creds,
    readonly workspaceId: string,
    readonly docId: string,
  ) {
    this.ws = new WebSocket(url)
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg
      this.inbox.push(msg)
      if (msg.type === 'welcome') {
        const w = msg as WelcomeMsg
        this.clientId = w.clientId
        this.userId = w.userId
        this.role = w.role
        if (w.snapshot) {
          this.doc = w.doc
          this.revision = w.revision
        }
      }
      this.onServerMessage(msg)
      this.waiters = this.waiters.filter((wt) => {
        if (wt.pred(msg)) {
          wt.resolve(msg)
          return false
        }
        return true
      })
    })
    this.ws.on('error', () => {})
  }

  /** 子类钩子：叠加各自的消息处理（如 OT） */
  protected onServerMessage(_msg: ServerMsg): void {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
    })
  }

  async join(lastRevision?: number) {
    await this.open()
    this.send({
      type: 'join',
      workspaceId: this.workspaceId,
      docId: this.docId,
      token: this.creds.token,
      lastRevision,
    })
    await this.waitFor((m) => m.type === 'welcome')
  }

  send(obj: object) {
    this.ws.send(JSON.stringify(obj))
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }

  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 3000): Promise<ServerMsg> {
    const hit = this.inbox.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor 超时')), timeoutMs)
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }
}
