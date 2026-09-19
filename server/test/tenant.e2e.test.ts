/**
 * 多租户权限体系端到端测试：
 * REST 鉴权与可见性、在线改权实时推送、降权在途操作拦截、权限收回踢下线、
 * 同账号多连接同步、成员移除联动、审计记录、最近文档。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { RestClient, setupScenario, AuthTestClient } from './helpers'
import type { PermissionUpdateMsg, PresenceMsg, ServerMsg } from '../../shared/protocol'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HTTP_BASE = 'http://localhost:18098'
const WS_BASE = 'ws://localhost:18098/ws'

process.env.PORT = '18098'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-tenant-'))
const { server, shutdown } = await import('../src/index')

const rest = new RestClient(HTTP_BASE)

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('租户: 未登录受保护接口 401；登录后 /me 正确', async () => {
  await assert.rejects(
    () => rest.call('GET', '/api/workspaces'),
    (e: any) => e.status === 401,
  )
  const scn = await setupScenario(HTTP_BASE)
  const me = await rest.call<{ account: { id: string } }>(
    'GET',
    '/api/auth/me',
    undefined,
    scn.admin.token,
  )
  assert.equal(me.account.id, scn.admin.userId)
})

test('租户: 非成员访问工作区/文档被拒；无文档权限 boot 403', async () => {
  const scn = await setupScenario(HTTP_BASE)
  const outsider = await setupScenario(HTTP_BASE) // 另一个完全独立的租户
  await assert.rejects(
    () => rest.call('GET', `/api/workspaces/${scn.workspaceId}`, undefined, outsider.admin.token),
    (e: any) => e.status === 403,
  )
  // m1 是工作区成员但未被授予该文档
  await assert.rejects(
    () =>
      rest.call(
        'GET',
        `/api/workspaces/${scn.workspaceId}/docs/${scn.docId}/boot`,
        undefined,
        scn.members.m1.token,
      ),
    (e: any) => e.status === 403,
  )
  // 文档目录对 m1 为空（无任何授权文档）
  const docs = await rest.call<any[]>(
    'GET',
    `/api/workspaces/${scn.workspaceId}/docs`,
    undefined,
    scn.members.m1.token,
  )
  assert.deepEqual(docs, [])
})

test('权限: 管理员隐式 manager；非管理者不能配置权限/看审计', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  // editor 不能查看权限配置
  await assert.rejects(
    () =>
      rest.call(
        'GET',
        `/api/workspaces/${scn.workspaceId}/docs/${scn.docId}/permissions`,
        undefined,
        scn.members.m1.token,
      ),
    (e: any) => e.status === 403,
  )
  // 工作区创建者（admin）隐式 manager，可查看
  const plist = await scn.permissions()
  assert.ok(plist.permissions.some((p: any) => p.userId === scn.admin.userId && p.role === 'manager' && p.implicit))
})

test('实时改权: 编辑→查看，在线收到 perm:update，在途编辑被拦截，presence 更新', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  const admin = new AuthTestClient(WS_BASE, scn.admin, scn.workspaceId, scn.docId)
  const target = new AuthTestClient(WS_BASE, scn.members.m1, scn.workspaceId, scn.docId)
  await admin.join()
  await target.join()
  assert.equal(target.role, 'editor')

  // 管理员在线将 m1 降为 viewer
  await scn.grant(scn.members.m1, 'viewer')

  // 被改权者实时收到新角色
  const upd = (await target.waitFor((m) => m.type === 'perm:update')) as PermissionUpdateMsg
  assert.equal(upd.role, 'viewer')
  target.role = upd.role

  // 管理者端收到 presence，m1 角色已变为 viewer（跳过加入时的旧 presence）
  const presence = (await admin.waitFor(
    (m) => m.type === 'presence' && (m as PresenceMsg).users.some((x) => x.userId === scn.members.m1.userId && x.role === 'viewer'),
  )) as PresenceMsg
  const u = presence.users.find((x) => x.userId === scn.members.m1.userId)
  assert.equal(u?.role, 'viewer')

  // 在途（降权后到达服务端）的编辑操作被逐条拦截
  target.send({ type: 'op', revision: target.revision, op: [{ insert: 'NA' }], opId: 'inflight-1' })
  const err = await target.waitFor((m) => m.type === 'error' && m.opId === 'inflight-1')
  assert.equal((err as { code: string }).code, 'PERMISSION_DENIED')

  // 批注也被禁止（viewer）
  target.send({ type: 'ann:add', annId: 'a-x', start: 0, end: 1, quote: 'q', text: 't' })
  const err2 = await target.waitFor((m) => m.type === 'error' && m.message.includes('批注'))
  assert.equal((err2 as { code: string }).code, 'PERMISSION_DENIED')

  admin.close()
  target.close()
})

test('实时改权: 编辑→批注 仅禁止正文；查看→编辑 升权后可编辑', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  const target = new AuthTestClient(WS_BASE, scn.members.m1, scn.workspaceId, scn.docId)
  await target.join()

  await scn.grant(scn.members.m1, 'commenter')
  const upd = (await target.waitFor((m) => m.type === 'perm:update')) as PermissionUpdateMsg
  assert.equal(upd.role, 'commenter')

  // 编辑被拒
  target.send({ type: 'op', revision: target.revision, op: [{ insert: 'z' }], opId: 'c1' })
  const err = await target.waitFor((m) => m.type === 'error' && m.opId === 'c1')
  assert.equal((err as { code: string }).code, 'PERMISSION_DENIED')

  // 批注仍允许
  target.send({ type: 'ann:add', annId: 'a-ok', start: 0, end: 0, quote: '', text: '批注可行' })
  const upsert = await target.waitFor((m) => m.type === 'ann:upsert')
  assert.equal((upsert as any).ann.id, 'a-ok')

  // 升权为 editor
  await scn.grant(scn.members.m1, 'editor')
  await target.waitFor((m) => m.type === 'perm:update' && (m as PermissionUpdateMsg).role === 'editor')
  target.send({ type: 'op', revision: target.revision, op: [{ insert: 'now-editable' }], opId: 'c2' })
  const ack = await target.waitFor((m) => m.type === 'ack' && m.opId === 'c2')
  assert.equal((ack as { revision: number }).revision >= 1, true)

  target.close()
})

test('权限收回: 移除文档权限 → perm:update(null) + 连接 4003 关闭，且不再收到广播', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  const admin = new AuthTestClient(WS_BASE, scn.admin, scn.workspaceId, scn.docId)
  const target = new AuthTestClient(WS_BASE, scn.members.m1, scn.workspaceId, scn.docId)
  await admin.join()
  await target.join()

  const revokeMsg = new Promise<PermissionUpdateMsg>((resolve) =>
    target.ws.once('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg
      if (m.type === 'perm:update') resolve(m as PermissionUpdateMsg)
    }),
  )
  const closeCode = new Promise<number>((resolve) => target.ws.once('close', (c) => resolve(c)))

  await scn.grant(scn.members.m1, null)

  const m = await revokeMsg
  assert.equal(m.role, null)
  assert.equal(await closeCode, 4003)

  // 被踢后无法用同令牌重新加入该文档（服务端已无权限）
  const rejoin = new AuthTestClient(WS_BASE, scn.members.m1, scn.workspaceId, scn.docId)
  const rejoinClose = new Promise<number>((resolve) => rejoin.ws.once('close', (c) => resolve(c)))
  await rejoin.open()
  rejoin.send({
    type: 'join',
    workspaceId: scn.workspaceId,
    docId: scn.docId,
    token: scn.members.m1.token,
  })
  assert.equal(await rejoinClose, 4003)

  admin.close()
})

test('多连接: 同账号两个标签同时在线，改权两者都收到', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'viewer')
  const tab1 = new AuthTestClient(WS_BASE, scn.members.m1, scn.workspaceId, scn.docId)
  const tab2 = new AuthTestClient(WS_BASE, scn.members.m1, scn.workspaceId, scn.docId)
  await tab1.join()
  await tab2.join()

  await scn.grant(scn.members.m1, 'editor')
  const u1 = (await tab1.waitFor((m) => m.type === 'perm:update')) as PermissionUpdateMsg
  const u2 = (await tab2.waitFor((m) => m.type === 'perm:update')) as PermissionUpdateMsg
  assert.equal(u1.role, 'editor')
  assert.equal(u2.role, 'editor')

  tab1.close()
  tab2.close()
})

test('成员移除: 移出工作区后在线连接被断开（4003）', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  const target = new AuthTestClient(WS_BASE, scn.members.m1, scn.workspaceId, scn.docId)
  await target.join()
  const closeCode = new Promise<number>((resolve) => target.ws.once('close', (c) => resolve(c)))

  await rest.call(
    'DELETE',
    `/api/workspaces/${scn.workspaceId}/members/${scn.members.m1.userId}`,
    undefined,
    scn.admin.token,
  )
  assert.equal(await closeCode, 4003)

  // 移除后 boot 也被拒（已非成员）
  await assert.rejects(
    () =>
      rest.call(
        'GET',
        `/api/workspaces/${scn.workspaceId}/docs/${scn.docId}/boot`,
        undefined,
        scn.members.m1.token,
      ),
    (e: any) => e.status === 403,
  )
})

test('审计: 文档权限变更被完整记录，含 from/to 与操作人', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  await scn.grant(scn.members.m1, 'commenter')
  await scn.grant(scn.members.m1, null)

  const audit = await rest.call<any[]>(
    'GET',
    `/api/workspaces/${scn.workspaceId}/docs/${scn.docId}/audit`,
    undefined,
    scn.admin.token,
  )
  // 最新在前：null ← commenter ← editor
  assert.equal(audit[0].toRole, null)
  assert.equal(audit[0].fromRole, 'commenter')
  assert.equal(audit[0].targetUserId, scn.members.m1.userId)
  assert.equal(audit[0].operatorId, scn.admin.userId)
  assert.equal(audit[0].kind, 'doc-permission')
  assert.equal(audit[1].toRole, 'commenter')
  assert.equal(audit[1].fromRole, 'editor')

  // 工作区成员角色变更也记录到工作区级审计（m2 已存在，用 PUT 提升为管理员）
  await rest.call(
    'PUT',
    `/api/workspaces/${scn.workspaceId}/members/${scn.members.m2.userId}`,
    { role: 'admin' },
    scn.admin.token,
  )
  const audit2 = await rest.call<any[]>(
    'GET',
    `/api/workspaces/${scn.workspaceId}/docs/${scn.docId}/audit`,
    undefined,
    scn.admin.token,
  )
  // 文档审计接口只返回该文档事件（工作区角色事件不带 docId，不应出现）
  assert.ok(!audit2.some((a) => a.kind === 'workspace-role'))
})

test('最近文档: 进入文档后出现在 home.recent', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'viewer')
  // 经 boot 进入（与真实客户端进入编辑器前的预加载一致）
  await rest.call(
    'GET',
    `/api/workspaces/${scn.workspaceId}/docs/${scn.docId}/boot`,
    undefined,
    scn.members.m1.token,
  )
  const home = await rest.call<{ recent: { doc: { id: string } }[] }>(
    'GET',
    '/api/home',
    undefined,
    scn.members.m1.token,
  )
  assert.ok(home.recent.some((r) => r.doc.id === scn.docId))
})

test('可见性隔离: 用户只看到自己所属工作区与有权限文档', async () => {
  const a = await setupScenario(HTTP_BASE)
  const b = await setupScenario(HTTP_BASE)
  const homeA = await rest.call<{ workspaces: { id: string }[] }>(
    'GET',
    '/api/home',
    undefined,
    a.admin.token,
  )
  const idsA = new Set(homeA.workspaces.map((w) => w.id))
  assert.ok(idsA.has(a.workspaceId))
  assert.ok(!idsA.has(b.workspaceId))
})
