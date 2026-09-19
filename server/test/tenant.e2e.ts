/**
 * 多租户权限体系端到端测试：
 * - 令牌鉴权 join，角色由服务端成员关系下发；
 * - 管理员在线调整角色 → 目标连接实时收到 perm:changed，presence 角色同步；
 * - 在途编辑操作在降权后被服务端拦截（PERMISSION_DENIED）；
 * - 成员被移除 → 在线连接收到 doc:closed；
 * - HTTP 权限调整写入完整审计记录。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import type { PermChangedMsg, ServerMsg, WelcomeMsg } from '../../shared/protocol'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDoc, grant, http, login } from './helpers'

process.env.PORT = '18095'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-tenant-'))
const { server, shutdown, tenantStore } = await import('../src/index')

const BASE_HTTP = 'http://localhost:18095'
const BASE = 'ws://localhost:18095/ws'

interface CollectedWs {
  ws: WebSocket
  inbox: ServerMsg[]
  /** 等待一条满足条件的消息；先查已收集的收件箱，避免注册监听器前的竞态丢帧 */
  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs?: number): Promise<ServerMsg>
  send(obj: object): void
  close(): void
}

function wrap(ws: WebSocket): CollectedWs {
  const inbox: ServerMsg[] = []
  const waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = []
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMsg
    inbox.push(m)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        waiters.splice(i, 1)[0].resolve(m)
      }
    }
  })
  return {
    ws,
    inbox,
    waitFor(pred, timeoutMs = 3000) {
      const hit = inbox.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise<ServerMsg>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitFor 超时')), timeoutMs)
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer)
            resolve(m)
          },
        })
      })
    },
    send(obj: object) {
      ws.send(JSON.stringify(obj))
    },
    close() {
      ws.close()
    },
  }
}

/** 建立连接并完成 join，返回常驻收消息的封装客户端 */
async function open(token: string, docId: string): Promise<CollectedWs> {
  const ws = new WebSocket(BASE)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const c = wrap(ws)
  c.send({ type: 'join', docId, token })
  await c.waitFor((m) => m.type === 'welcome')
  return c
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('租户: welcome 下发服务端解析的角色，而非客户端自选', async () => {
  const admin = await login(BASE_HTTP, 'admin', 'admin123')
  const docId = await createDoc(BASE_HTTP, admin.token, '角色下发')
  await grant(BASE_HTTP, admin.token, docId, 'viewer', 'viewer')
  const viewerToken = (await login(BASE_HTTP, 'viewer', 'viewer123')).token

  const ws = new WebSocket(BASE)
  await new Promise<void>((r) => ws.once('open', r))
  const c = wrap(ws)
  // 即使客户端伪造 name/role，服务端也只认成员关系
  c.send({ type: 'join', docId, token: viewerToken, name: 'hacker', role: 'admin' } as object)
  const welcome = (await c.waitFor((m) => m.type === 'welcome')) as WelcomeMsg
  assert.equal(welcome.role, 'viewer')
  assert.equal(welcome.userId, 'user-viewer')
  c.close()
})

test('租户: 在线降权实时推送 perm:changed，并拦截在途编辑操作', async () => {
  const admin = await login(BASE_HTTP, 'admin', 'admin123')
  const docId = await createDoc(BASE_HTTP, admin.token, '在线降权')
  await grant(BASE_HTTP, admin.token, docId, 'editor', 'editor')
  const editorToken = (await login(BASE_HTTP, 'editor', 'editor123')).token

  const adminWs = await open(admin.token, docId)
  const editorWs = await open(editorToken, docId)

  // 管理员把 editor 从 editor 降为 viewer
  const grantRes = await http(BASE_HTTP, `/api/docs/${docId}/members`, 'PUT', {
    username: 'editor',
    role: 'viewer',
  }, admin.token)
  assert.equal(grantRes.status, 200)

  // editor 的连接实时收到 perm:changed
  const changed = (await editorWs.waitFor((m) => m.type === 'perm:changed')) as PermChangedMsg
  assert.equal(changed.role, 'viewer')

  // 在途操作拦截：降权后 editor 再提交编辑 → PERMISSION_DENIED
  editorWs.send({ type: 'op', revision: 0, op: [{ insert: '越权修改' }], opId: 'bad-1' })
  const err = await editorWs.waitFor(
    (m) => m.type === 'error' && (m as { opId?: string }).opId === 'bad-1',
  )
  assert.equal((err as { code: string }).code, 'PERMISSION_DENIED')

  // 批注操作同样被拦截（无 opId 的批注类错误）
  editorWs.send({ type: 'ann:add', annId: 'a-bad', start: 0, end: 1, quote: 'x', text: '越权批注' })
  const err2 = (await editorWs.waitFor(
    (m) => m.type === 'error' && !(m as { opId?: string }).opId && (m as { message: string }).message.includes('批注'),
  )) as { code: string; message: string }
  assert.equal(err2.code, 'PERMISSION_DENIED')
  assert.ok(err2.message.includes('批注'))

  // 数据层角色已更新：重新 join 仍为 viewer
  const editorWs2 = await open(editorToken, docId)
  const w2 = await editorWs2.waitFor((m) => m.type === 'welcome')
  assert.equal((w2 as WelcomeMsg).role, 'viewer')

  adminWs.close()
  editorWs.close()
  editorWs2.close()
})

test('租户: 升级权限后立即获得编辑能力，无需重连', async () => {
  const admin = await login(BASE_HTTP, 'admin', 'admin123')
  const docId = await createDoc(BASE_HTTP, admin.token, '在线升级')
  await grant(BASE_HTTP, admin.token, docId, 'commenter', 'commenter')
  const token = (await login(BASE_HTTP, 'commenter', 'commenter123')).token

  const ws = await open(token, docId)
  // 升级为 editor
  await http(BASE_HTTP, `/api/docs/${docId}/members`, 'PUT', { username: 'commenter', role: 'editor' }, admin.token)
  const changed = (await ws.waitFor((m) => m.type === 'perm:changed')) as PermChangedMsg
  assert.equal(changed.role, 'editor')

  // 不需要重连即可编辑成功
  ws.send({ type: 'op', revision: 0, op: [{ insert: 'now i can edit' }], opId: 'ok-1' })
  const ack = await ws.waitFor((m) => m.type === 'ack' && (m as { opId: string }).opId === 'ok-1')
  assert.equal(ack.type, 'ack')
  ws.close()
})

test('租户: 成员被移除 → 在线连接收到 doc:closed，且不能再 join', async () => {
  const admin = await login(BASE_HTTP, 'admin', 'admin123')
  const docId = await createDoc(BASE_HTTP, admin.token, '移除成员')
  await grant(BASE_HTTP, admin.token, docId, 'editor', 'editor')
  const editorToken = (await login(BASE_HTTP, 'editor', 'editor123')).token
  const editorId = 'user-editor'

  const ws = await open(editorToken, docId)
  await http(BASE_HTTP, `/api/docs/${docId}/members/${editorId}`, 'DELETE', undefined, admin.token)

  const closed = await ws.waitFor((m) => m.type === 'doc:closed')
  assert.equal(closed.type, 'doc:closed')

  // 被移除后重新 join 被拒
  const ws2 = new WebSocket(BASE)
  await new Promise<void>((r) => ws2.once('open', r))
  const c2 = wrap(ws2)
  c2.send({ type: 'join', docId, token: editorToken })
  const err = await c2.waitFor((m) => m.type === 'error')
  assert.equal((err as { code: string }).code, 'PERMISSION_DENIED')
  c2.close()
})

test('租户: 文档删除广播 doc:closed 给所有在线协作者', async () => {
  const admin = await login(BASE_HTTP, 'admin', 'admin123')
  const docId = await createDoc(BASE_HTTP, admin.token, '删除文档')
  await grant(BASE_HTTP, admin.token, docId, 'viewer', 'viewer')
  const viewerToken = (await login(BASE_HTTP, 'viewer', 'viewer123')).token

  const adminWs = await open(admin.token, docId)
  const viewerWs = await open(viewerToken, docId)

  await http(BASE_HTTP, `/api/docs/${docId}`, 'DELETE', undefined, admin.token)

  const closed = await viewerWs.waitFor((m) => m.type === 'doc:closed')
  assert.equal((closed as { docId: string }).docId, docId)

  // 文档删除后数据层不再存在该文档
  assert.equal(tenantStore.resolveDocRole(docId, 'user-viewer'), null)
  adminWs.close()
  viewerWs.close()
})

test('租户: 权限变更与文档管理操作写入完整审计记录', async () => {
  const admin = await login(BASE_HTTP, 'admin', 'admin123')
  const docId = await createDoc(BASE_HTTP, admin.token, '审计文档')
  await grant(BASE_HTTP, admin.token, docId, 'editor', 'editor')
  await http(BASE_HTTP, `/api/docs/${docId}/members`, 'PUT', { username: 'editor', role: 'commenter' }, admin.token)
  await http(BASE_HTTP, `/api/docs/${docId}/members/user-editor`, 'DELETE', undefined, admin.token)

  const res = await http(BASE_HTTP, `/api/docs/${docId}/audit`, 'GET', undefined, admin.token)
  assert.equal(res.status, 200)
  const actions = (res.data as { entries: { action: string; detail: string; actorName: string }[] }).entries.map(
    (e) => e.action,
  )
  assert.ok(actions.includes('member.grant'), `应含授权记录: ${actions.join(',')}`)
  assert.ok(actions.includes('member.update'), `应含角色调整记录: ${actions.join(',')}`)
  assert.ok(actions.includes('member.remove'), `应含移除记录: ${actions.join(',')}`)

  const update = (res.data as { entries: { action: string; detail: string }[] }).entries.find(
    (e) => e.action === 'member.update',
  )!
  // 详情保留旧值/新值
  assert.ok(update.detail.includes('editor') && update.detail.includes('commenter'))

  // 非文档管理员不能查看审计
  const viewer = await login(BASE_HTTP, 'viewer', 'viewer123')
  const forbidden = await http(BASE_HTTP, `/api/docs/${docId}/audit`, 'GET', undefined, viewer.token)
  // viewer 不在该文档中 → 403（或工作区非管理员同样被拒）
  assert.ok(forbidden.status === 403)
})

test('租户: 目录与最近协作按权限过滤', async () => {
  const admin = await login(BASE_HTTP, 'admin', 'admin123')
  const docId = await createDoc(BASE_HTTP, admin.token, '目录可见性')

  // commenter 是工作区成员但未被授权该文档
  const commenter = await login(BASE_HTTP, 'commenter', 'commenter123')
  const listRes = await http<{ docs: { doc: { id: string } }[] }>(
    BASE_HTTP,
    '/api/workspaces/demo-ws/docs',
    'GET',
    undefined,
    commenter.token,
  )
  assert.equal(listRes.status, 200)
  assert.ok(!listRes.data.docs.some((d) => d.doc.id === docId), '未授权文档不应出现在目录中')

  // 打开未授权文档 → 403
  const denied = await http(BASE_HTTP, `/api/docs/${docId}`, 'GET', undefined, commenter.token)
  assert.equal(denied.status, 403)

  // 管理员打开后最近协作包含该文档
  await http(BASE_HTTP, `/api/docs/${docId}/opened`, 'POST', undefined, admin.token)
  const recent = await http<{ recent: { docId: string }[] }>(BASE_HTTP, '/api/recent', 'GET', undefined, admin.token)
  assert.ok(recent.data.recent.some((r) => r.docId === docId))
})
