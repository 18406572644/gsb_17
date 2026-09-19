import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { apply, transformPair, type Op } from '../../shared/ot'
import type { ServerMsg, WelcomeMsg } from '../../shared/protocol'
import { AuthTestClient, setupScenario, type Creds, type Scenario } from './helpers'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HTTP_BASE = 'http://localhost:18099'
const WS_BASE = 'ws://localhost:18099/ws'

process.env.PORT = '18099'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'collab-e2e-'))
const { server, shutdown } = await import('../src/index')

/** 在鉴权客户端上叠加基础 OT 处理与编辑能力 */
class OtClient extends AuthTestClient {
  pending: { opId: string; op: Op } | null = null
  private opCounter = 0

  protected override onServerMessage(msg: ServerMsg) {
    switch (msg.type) {
      case 'ops': {
        for (const e of msg.ops) {
          if (this.pending && this.pending.opId === e.opId) {
            this.pending = null
            continue
          }
          if (this.pending) {
            const [rP, pP] = transformPair(e.op, this.pending.op)
            this.doc = apply(this.doc, rP)
            this.pending.op = pP
          } else {
            this.doc = apply(this.doc, e.op)
          }
        }
        this.revision = msg.revision
        break
      }
      case 'ack':
        this.pending = null
        this.revision = msg.revision
        break
      case 'op': {
        if (this.pending) {
          const [rP, pP] = transformPair(msg.op, this.pending.op)
          this.doc = apply(this.doc, rP)
          this.pending.op = pP
        } else {
          this.doc = apply(this.doc, msg.op)
        }
        this.revision = msg.revision + 1
        break
      }
    }
  }

  edit(op: Op) {
    const opId = `${this.creds.username}-${this.opCounter++}`
    this.doc = apply(this.doc, op)
    this.pending = { opId, op }
    this.send({ type: 'op', revision: this.revision, op, opId })
    return opId
  }
}

async function connect(scn: Scenario, creds: Creds): Promise<OtClient> {
  const c = new OtClient(WS_BASE, creds, scn.workspaceId, scn.docId)
  await c.join()
  return c
}

before(async () => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)))
})

after(() => {
  shutdown()
})

test('e2e: 双客户端并发编辑收敛', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  await scn.grant(scn.members.m2, 'editor')
  const a = await connect(scn, scn.members.m1)
  const b = await connect(scn, scn.members.m2)

  // 同一同步块内背靠背提交：两个操作真正并发，服务端按到达顺序接受并变换
  a.edit([{ insert: 'hello' }])
  b.edit([{ insert: 'world' }])

  await a.waitFor((m) => m.type === 'ack')
  await b.waitFor((m) => m.type === 'ack')
  await a.waitFor((m) => m.type === 'op')
  await b.waitFor((m) => m.type === 'op')

  await new Promise((r) => setTimeout(r, 200))
  assert.equal(a.doc, b.doc)
  assert.ok(a.doc.length === 10, `文档应包含两个插入: ${a.doc}`)
  assert.equal(a.revision, 2)
  assert.equal(b.revision, 2)

  // 新加入的查看者拿到一致的全量文档
  await scn.grant(scn.members.m3, 'viewer')
  const c = await connect(scn, scn.members.m3)
  assert.equal(c.doc, a.doc)
  a.close()
  b.close()
  c.close()
})

test('e2e: 权限控制 —— 查看不可编辑/批注，批注者可批注不可编辑', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  await scn.grant(scn.members.m2, 'viewer')
  await scn.grant(scn.members.m3, 'commenter')
  const editor = await connect(scn, scn.members.m1)
  const viewer = await connect(scn, scn.members.m2)
  const commenter = await connect(scn, scn.members.m3)

  assert.equal(editor.role, 'editor')
  assert.equal(viewer.role, 'viewer')
  assert.equal(commenter.role, 'commenter')

  editor.edit([{ insert: 'abcdef' }])
  await editor.waitFor((m) => m.type === 'ack')

  // viewer 编辑 → 拒绝
  viewer.send({ type: 'op', revision: 1, op: [{ retain: 6 }, { insert: 'x' }], opId: 'v1' })
  const errV = await viewer.waitFor((m) => m.type === 'error')
  assert.equal((errV as { code: string }).code, 'PERMISSION_DENIED')

  // commenter 编辑 → 拒绝
  commenter.send({ type: 'op', revision: 1, op: [{ retain: 6 }, { insert: 'x' }], opId: 'm1' })
  const errM = await commenter.waitFor((m) => m.type === 'error')
  assert.equal((errM as { code: string }).code, 'PERMISSION_DENIED')

  // commenter 批注 → 成功，多方都收到广播
  commenter.send({ type: 'ann:add', annId: 'ann-1', start: 1, end: 3, quote: 'bc', text: '这里建议修改' })
  const up = (await editor.waitFor((m) => m.type === 'ann:upsert')) as {
    ann: { id: string; start: number; end: number }
  }
  assert.equal(up.ann.id, 'ann-1')
  assert.equal(up.ann.start, 1)
  assert.equal(up.ann.end, 3)
  await viewer.waitFor((m) => m.type === 'ann:upsert')

  // viewer 批注 → 拒绝
  viewer.send({ type: 'ann:add', annId: 'ann-2', start: 0, end: 1, quote: 'a', text: 'x' })
  const errV2 = await viewer.waitFor((m) => m.type === 'error' && m.message.includes('批注'))
  assert.equal((errV2 as { code: string }).code, 'PERMISSION_DENIED')

  // 编辑导致批注锚点移动：在位置 0 插入 2 个字符 → [1,3) → [3,5)
  editor.edit([{ insert: '>>' }, { retain: 6 }])
  await editor.waitFor((m) => m.type === 'ack')
  const fresh = await connect(scn, scn.members.m3)
  const welcome = fresh.inbox.find((m) => m.type === 'welcome') as WelcomeMsg
  const ann = welcome.annotations.find((x) => x.id === 'ann-1')!
  assert.equal(ann.start, 3)
  assert.equal(ann.end, 5)

  editor.close()
  viewer.close()
  commenter.close()
  fresh.close()
})

test('e2e: 断线重连 —— 增量补齐错过的操作', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  await scn.grant(scn.members.m2, 'editor')
  const a = await connect(scn, scn.members.m1)
  const b = await connect(scn, scn.members.m2)

  a.edit([{ insert: 'v1 ' }])
  await a.waitFor((m) => m.type === 'ack')
  await b.waitFor((m) => m.type === 'op')

  const bRev = b.revision
  b.close()
  await new Promise((r) => setTimeout(r, 100))
  a.edit([{ retain: 3 }, { insert: 'v2 ' }])
  await a.waitFor((m) => m.type === 'ack' && (m as { revision: number }).revision === 2)
  a.edit([{ retain: 6 }, { insert: 'v3' }])
  await a.waitFor((m) => m.type === 'ack' && (m as { revision: number }).revision === 3)

  // B 重连并携带旧版本号 → 收到增量 ops
  const b2 = new OtClient(WS_BASE, scn.members.m2, scn.workspaceId, scn.docId)
  b2.doc = b.doc
  b2.revision = bRev
  await b2.join(bRev)
  const opsMsg = (await b2.waitFor((m) => m.type === 'ops')) as { ops: unknown[]; revision: number }
  assert.equal(opsMsg.ops.length, 2)
  assert.equal(opsMsg.revision, 3)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(b2.doc, 'v1 v2 v3')
  assert.equal(b2.revision, 3)

  a.close()
  b2.close()
})

test('e2e: 版本过旧 —— 回退全量快照', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  const a = await connect(scn, scn.members.m1)
  a.edit([{ insert: 'snap' }])
  await a.waitFor((m) => m.type === 'ack')

  await scn.grant(scn.members.m2, 'editor')
  const b = new OtClient(WS_BASE, scn.members.m2, scn.workspaceId, scn.docId)
  await b.join(-1)
  const w = b.inbox.find((m) => m.type === 'welcome') as WelcomeMsg
  assert.equal(w.snapshot, true)
  assert.equal(w.doc, 'snap')
  a.close()
  b.close()
})

test('e2e: 重复 opId 幂等（ack 丢失重发不重复应用）', async () => {
  const scn = await setupScenario(HTTP_BASE)
  await scn.grant(scn.members.m1, 'editor')
  await scn.grant(scn.members.m2, 'viewer')
  const a = await connect(scn, scn.members.m1)
  a.send({ type: 'op', revision: 0, op: [{ insert: 'x' }], opId: 'dup-1' })
  await a.waitFor((m) => m.type === 'ack')
  // 模拟 ack 丢失后客户端重发同一操作
  a.send({ type: 'op', revision: 0, op: [{ insert: 'x' }], opId: 'dup-1' })
  await new Promise((r) => setTimeout(r, 300))
  const b = await connect(scn, scn.members.m2)
  assert.equal(b.doc, 'x') // 只被应用了一次
  a.close()
  b.close()
})

test('e2e: 伪造令牌 / 无权限 join 被拒，畸形消息不炸服务器', async () => {
  const scn = await setupScenario(HTTP_BASE)

  // 伪造令牌 join → 未认证，服务端以 4001 关闭
  const bad = new WebSocket(WS_BASE)
  await new Promise<void>((r) => bad.once('open', r))
  const closed = new Promise<number>((resolve) => bad.on('close', (code) => resolve(code)))
  bad.send('not-json{{{')
  bad.send(
    JSON.stringify({ type: 'join', workspaceId: scn.workspaceId, docId: scn.docId, token: 'forged-token' }),
  )
  const code = await closed
  assert.equal(code, 4001)

  // 合法工作区成员但对该文档无权限 → 拒绝（4003）
  const noAccess = new OtClient(WS_BASE, scn.members.m3, scn.workspaceId, scn.docId)
  const closed2 = new Promise<number>((resolve) => noAccess.ws.on('close', (c) => resolve(c)))
  await noAccess.open()
  noAccess.send({
    type: 'join',
    workspaceId: scn.workspaceId,
    docId: scn.docId,
    token: scn.members.m3.token,
  })
  const code2 = await closed2
  assert.equal(code2, 4003)
})
