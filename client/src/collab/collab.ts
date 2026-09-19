/**
 * 协同编排层：把 WSClient（连接）/ OTClient（并发控制）/ Pinia stores（状态）粘合起来。
 *
 * 多租户与权限：
 * - 进入编辑器前先经 REST /boot 预加载权限，WS join 携带令牌由服务端做权威鉴权；
 * - 管理员在线改权 → perm:update 实时下发：立即更新本地角色、禁用对应能力；
 *   若被降权（失去编辑）且存在未确认的在途编辑，丢弃本地乐观修改并全量重同步到服务端版本；
 * - 权限被彻底收回 → perm:update(role=null) / close 4003：停止自动重连，退回工作区首页；
 * - 所有写操作服务端逐条按「当前」权限复核，本地拦截仅为体验优化。
 *
 * 异常链路（不变）：断网指数退避重连 → 增量补齐 / 全量快照；seq 空洞与 ack 超时触发重同步。
 */
import { ElMessage } from 'element-plus'
import { apply, diffToOp, isNoop, mapPosition, type Op } from '../../../shared/ot'
import type {
  Annotation,
  ErrorMsg,
  OpsMsg,
  PermissionUpdateMsg,
  RemoteOpMsg,
  Role,
  ServerMsg,
  WelcomeMsg,
} from '../../../shared/protocol'
import { ROLE_RANK, canAnnotate, canEdit } from '../../../shared/protocol'
import { WSClient } from '@/ws/wsClient'
import { OTClient } from '@/ot/otClient'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { useAuthStore } from '@/stores/auth'

type RemoteListener = (op: Op) => void

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface EnterOptions {
  workspaceId: string
  docId: string
  docTitle: string
  role: Role
}

class Collab {
  private ws = new WSClient()
  private ot: OTClient
  private lastSeq = 0
  private resyncing = false
  private remoteListeners: RemoteListener[] = []
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private lastCursorSent = 0
  private joinedOnce = false
  /** 权限收回回调（App 注册以退回工作区首页） */
  onAccessRevoked: ((message: string) => void) | null = null

  constructor() {
    this.ot = new OTClient({
      sendOp: (op, opId, revision) => this.ws.send({ type: 'op', op, opId, revision }),
      applyRemote: (op) => this.applyRemoteToDoc(op),
      requestResync: () => this.requestResync(),
    })
    this.ws.onStatus = (status, attempt) => {
      const session = useSessionStore()
      session.status = status
      session.reconnectAttempt = attempt
      if (status !== 'online') {
        this.ot.setConnected(false)
        const doc = useDocStore()
        if (doc.syncState !== 'resyncing') doc.syncState = this.ot.pendingCount > 0 ? 'pending' : 'synced'
      }
    }
    this.ws.onOpen = () => {
      // 连接建立后立即（重）加入文档，携带令牌与本地版本号（增量补齐）
      const session = useSessionStore()
      const auth = useAuthStore()
      this.ws.send({
        type: 'join',
        workspaceId: session.workspaceId,
        docId: session.docId,
        token: auth.token,
        lastRevision: this.joinedOnce ? this.ot.revision : undefined,
      })
    }
    this.ws.onClose = (code) => {
      // 4003：服务端因权限收回关闭连接 —— 停止自动重连并退回首页
      if (code === 4003) {
        this.handleRevoked('你的文档访问权限已被收回')
      }
    }
    this.ws.onMessage = (msg) => {
      this.ws.noteAlive()
      this.handle(msg as ServerMsg)
    }
  }

  /** 注册远程操作应用监听（编辑器用来重映射光标/选区） */
  onRemoteApplied(fn: RemoteListener) {
    this.remoteListeners.push(fn)
    return () => {
      this.remoteListeners = this.remoteListeners.filter((f) => f !== fn)
    }
  }

  /** 进入文档（权限已由 REST boot 预加载） */
  enter(opts: EnterOptions) {
    const session = useSessionStore()
    const auth = useAuthStore()
    session.workspaceId = opts.workspaceId
    session.docId = opts.docId
    session.docTitle = opts.docTitle
    session.name = auth.account?.name || ''
    session.userId = auth.account?.id || ''
    session.role = opts.role
    session.joined = true
    session.accessRevoked = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws.connect(`${proto}://${location.host}/ws`)
  }

  leave() {
    this.ws.disconnect()
    this.ws.clearOutbox()
    this.joinedOnce = false
    useSessionStore().$reset()
    useDocStore().$reset()
    this.ot.rollback(0)
    this.lastSeq = 0
  }

  /** 模拟断网（演示断线重连 / 离线编辑） */
  simulateDrop() {
    const session = useSessionStore()
    session.simulatedOffline = true
    this.ws.disconnect()
    ElMessage.warning('已模拟断网：本地编辑会暂存，重新连接后自动同步')
  }

  reconnectNow() {
    const session = useSessionStore()
    session.simulatedOffline = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws.connect(`${proto}://${location.host}/ws`)
  }

  /* ---------------- 本地动作（先做本地权限拦截） ---------------- */

  /** 本地编辑：与当前文档 diff 生成操作，乐观应用并进入 OT 队列 */
  localEdit(newText: string) {
    const session = useSessionStore()
    if (!canEdit(session.role)) {
      ElMessage.error('当前权限为「查看/批注」，无法编辑正文')
      return
    }
    const doc = useDocStore()
    const op = diffToOp(doc.text, newText)
    if (isNoop(op)) return
    doc.text = newText
    this.transformAnnotations(op)
    this.ot.localChange(op)
    doc.syncState = 'pending'
  }

  addAnnotation(start: number, end: number, quote: string, text: string) {
    const session = useSessionStore()
    if (!canAnnotate(session.role)) {
      ElMessage.error('当前权限无批注权限')
      return
    }
    this.ws.send({ type: 'ann:add', annId: genId('ann'), start, end, quote, text })
  }

  replyAnnotation(annId: string, text: string) {
    if (!canAnnotate(useSessionStore().role)) {
      ElMessage.error('当前权限无批注权限')
      return
    }
    this.ws.send({ type: 'ann:reply', annId, replyId: genId('r'), text })
  }

  resolveAnnotation(annId: string, resolved: boolean) {
    if (!canAnnotate(useSessionStore().role)) {
      ElMessage.error('当前权限无批注权限')
      return
    }
    this.ws.send({ type: 'ann:resolve', annId, resolved })
  }

  deleteAnnotation(annId: string) {
    this.ws.send({ type: 'ann:delete', annId })
  }

  /** 光标上报：120ms 节流，断线/无查看权限时直接丢弃（易失消息） */
  sendCursor(start: number, end: number) {
    const now = Date.now()
    const doSend = () => {
      this.lastCursorSent = Date.now()
      this.ws.send({ type: 'cursor', start, end })
    }
    if (now - this.lastCursorSent >= 120) {
      doSend()
    } else if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null
        doSend()
      }, 120 - (now - this.lastCursorSent))
    }
  }

  /* ---------------- 服务端消息处理 ---------------- */

  private handle(msg: ServerMsg) {
    const session = useSessionStore()
    const doc = useDocStore()
    switch (msg.type) {
      case 'welcome':
        this.onWelcome(msg)
        break

      case 'ops': {
        // 增量补齐：重放错过的操作（含可能已收到的自己的操作，按 opId 去重）
        this.ot.resyncOps(msg.ops, msg.revision)
        doc.revision = this.ot.revision
        this.lastSeq = msg.seq
        this.finishResync()
        break
      }

      case 'op': {
        if (!this.checkSeq(msg.seq)) return
        this.ot.remoteChange(msg.op)
        doc.revision = this.ot.revision
        break
      }

      case 'ack': {
        if (!this.checkSeq(msg.seq)) return
        this.ot.ack(msg.opId, msg.revision)
        doc.revision = this.ot.revision
        this.refreshSyncState()
        break
      }

      case 'ann:upsert': {
        if (!this.checkSeq(msg.seq)) return
        doc.upsertAnnotation(msg.ann)
        break
      }

      case 'ann:delete': {
        if (!this.checkSeq(msg.seq)) return
        doc.removeAnnotation(msg.annId)
        break
      }

      case 'presence':
        session.setUsers(msg.users)
        break

      case 'cursor':
        if (msg.start < 0) {
          // 光标墓碑：对端连接已关闭（同账号多标签时清除其残留光标）
          delete session.cursors[msg.clientId]
        } else {
          session.cursors[msg.clientId] = { userId: msg.userId, start: msg.start, end: msg.end }
        }
        break

      case 'perm:update':
        this.onPermissionUpdate(msg)
        break

      case 'error':
        this.onError(msg)
        break

      case 'pong':
        break
    }
  }

  private onWelcome(msg: WelcomeMsg) {
    const session = useSessionStore()
    const doc = useDocStore()
    const wasRejoin = this.joinedOnce
    session.clientId = msg.clientId
    session.userId = msg.userId
    session.workspaceId = msg.workspaceId
    session.docId = msg.docId
    session.setRole(msg.role) // 重连时以服务端当前权限为准
    session.setUsers(msg.users)
    this.joinedOnce = true
    this.resyncing = true
    doc.syncState = 'resyncing'
    this.lastSeq = msg.seq

    if (msg.snapshot) {
      // 全量快照：回滚未确认的本地修改
      const hadUnsynced = this.ot.rollback(msg.revision)
      doc.text = msg.doc
      doc.revision = msg.revision
      doc.annotations = msg.annotations
      this.ws.clearOutbox()
      this.finishResync()
      if (hadUnsynced) {
        ElMessage.warning('连接已恢复，但部分未同步的本地修改已回滚（版本过旧或权限变更）')
      } else if (wasRejoin) {
        ElMessage.success('已重新连接并同步到最新版本')
      }
    } else {
      // 增量：保留本地文档与未确认操作，批注先以服务端为准，ops 到达后再重放本地未确认操作
      doc.annotations = msg.annotations
      if (wasRejoin) ElMessage.success('连接已恢复，正在增量同步')
    }
  }

  /** 在线权限变更：实时更新角色，降权时回滚在途编辑并重同步 */
  private onPermissionUpdate(msg: PermissionUpdateMsg) {
    const session = useSessionStore()
    if (msg.workspaceId !== session.workspaceId || msg.docId !== session.docId) return

    if (msg.role === null) {
      this.handleRevoked('你的文档访问权限已被管理员收回')
      return
    }

    const oldRole = session.role
    session.setRole(msg.role)
    const downgraded = ROLE_RANK[msg.role] < ROLE_RANK[oldRole]
    const by = msg.operatorName ? `（${msg.operatorName} 调整）` : ''

    if (downgraded) {
      session.permissionNotice = `权限已变更为「${msg.role}」${by}`
      ElMessage.warning(session.permissionNotice)
      // 失去编辑权限但本地有未确认编辑：这些修改不可能再被接受，丢弃并回到服务端版本
      if (!canEdit(msg.role) && this.ot.pendingCount > 0) {
        this.forceSnapshotResync('权限已降级，未同步的本地编辑被撤销')
      }
      if (!canAnnotate(msg.role)) {
        // 丢弃断线期间排队、降权后不再允许的批注类消息（op 由 OT 队列单独处理）
        this.ws.pruneOutbox((m) => typeof m.type === 'string' && m.type.startsWith('ann:'))
      }
    } else {
      ElMessage.success(`权限已提升为「${msg.role}」${by}`)
      session.permissionNotice = null
    }
  }

  private handleRevoked(message: string) {
    const session = useSessionStore()
    if (session.accessRevoked) return
    session.accessRevoked = true
    this.ws.disconnect()
    if (this.onAccessRevoked) this.onAccessRevoked(message)
  }

  /** 重同步完成：重放本地未确认操作对批注锚点的影响，补发离线队列，恢复状态 */
  private finishResync() {
    const doc = useDocStore()
    // 服务端批注锚点不含本地未确认操作的影响 → 在本地重放
    for (const op of this.ot.unackedOps) this.transformAnnotations(op)
    this.resyncing = false
    this.ot.setConnected(true)
    this.ws.flushOutbox()
    this.refreshSyncState()
  }

  /** seq 连续性检查：发现空洞（消息丢失）→ 主动重同步 */
  private checkSeq(seq: number): boolean {
    if (this.resyncing) return false
    if (seq <= this.lastSeq) return false // 重复/过期消息
    if (seq > this.lastSeq + 1) {
      console.warn(`[collab] 检测到消息空洞 lastSeq=${this.lastSeq} got=${seq}，请求重同步`)
      this.requestResync()
      return false
    }
    this.lastSeq = seq
    return true
  }

  private requestResync() {
    if (this.resyncing) return
    this.resyncing = true
    const doc = useDocStore()
    doc.syncState = 'resyncing'
    this.ws.send({ type: 'resync', lastRevision: this.ot.revision })
  }

  /** 强制全量快照重同步（降权撤销本地编辑 / 本地版本无法增量收敛时） */
  private forceSnapshotResync(toast?: string) {
    this.resyncing = true
    useDocStore().syncState = 'resyncing'
    this.ws.clearOutbox()
    this.ws.send({ type: 'resync', lastRevision: -1 })
    if (toast) ElMessage.warning(toast)
  }

  private onError(msg: ErrorMsg) {
    switch (msg.code) {
      case 'UNAUTHORIZED':
        this.handleRevoked('登录已失效，请重新登录')
        break
      case 'FORBIDDEN':
      case 'PERMISSION_DENIED': {
        ElMessage.error(msg.message)
        // 在途编辑被拒（典型：降权竞态）→ 丢弃本地未确认编辑，全量回到服务端版本
        if (msg.opId && this.ot.pendingCount > 0) {
          this.forceSnapshotResync()
        }
        break
      }
      case 'RESYNC_REQUIRED':
      case 'BAD_REVISION':
        ElMessage.warning(`${msg.message}，正在重新同步`)
        this.requestResync()
        break
      default:
        ElMessage.error(msg.message)
        this.requestResync()
    }
  }

  /** 远程操作（已完成 OT 变换）应用到本地文档 */
  private applyRemoteToDoc(op: Op) {
    const doc = useDocStore()
    doc.text = apply(doc.text, op)
    this.transformAnnotations(op)
    for (const fn of this.remoteListeners) fn(op)
  }

  /** 批注锚点随操作移动 */
  private transformAnnotations(op: Op) {
    const doc = useDocStore()
    for (const ann of doc.annotations) {
      ann.start = mapPosition(ann.start, op, 'after')
      ann.end = mapPosition(ann.end, op, 'before')
      if (ann.end < ann.start) ann.end = ann.start
      ann.orphan = ann.start === ann.end
    }
  }

  private refreshSyncState() {
    const doc = useDocStore()
    if (this.resyncing) doc.syncState = 'resyncing'
    else doc.syncState = this.ot.pendingCount > 0 ? 'pending' : 'synced'
  }
}

export const collab = new Collab()
