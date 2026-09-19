/**
 * 协同编排层：把 WSClient（连接）/ OTClient（并发控制）/ Pinia stores（状态）粘合起来。
 *
 * 多租户要点：
 * - join 只接收 docId，身份令牌来自 auth store，文档角色完全由服务端在 welcome 中下发；
 * - 管理员在线调整权限时，服务端推送 perm:changed → 立即更新本地门禁；
 *   若失去编辑权且存在未确认的乐观修改，主动全量重同步回滚，界面以服务端文档为准；
 * - 被移出文档 / 文档被删除时收到 doc:closed → 退出编辑器回到工作台。
 *
 * 异常链路：
 * - 断网：WSClient 指数退避重连 → 重连后带 lastRevision 重新 join → 服务端增量补发或全量快照；
 * - 消息丢失：广播消息携带 seq，客户端检测空洞主动 resync；ack 超时同样触发 resync；
 * - 状态回滚：服务端日志不足以下发增量时下发快照，客户端丢弃未确认修改并回滚到快照。
 */
import { ElMessage } from 'element-plus'
import { apply, diffToOp, isNoop, mapPosition, type Op } from '../../../shared/ot'
import type {
  Annotation,
  ErrorMsg,
  OpsMsg,
  PermChangedMsg,
  RemoteOpMsg,
  Role,
  ServerMsg,
  WelcomeMsg,
} from '../../../shared/protocol'
import { canEdit } from '../../../shared/protocol'
import { WSClient } from '@/ws/wsClient'
import { OTClient } from '@/ot/otClient'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { useAuthStore } from '@/stores/auth'
import { useWorkspaceStore } from '@/stores/workspace'
import { getToken } from '@/api/http'

type RemoteListener = (op: Op) => void

function genId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
  /** 已发送 join、尚未收到 welcome（用于判定 error 是否为准入拒绝） */
  private pendingJoin = false
  /** 被服务端拒绝进入（鉴权/权限）时的回调，工作台据此停留列表页 */
  onJoinRejected: ((message: string) => void) | null = null
  /** 文档被关闭/本人被移除时的回调 */
  onDocClosed: ((reason: string) => void) | null = null

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
      // 连接建立后立即（重）加入文档，携带令牌与本地版本号；角色由服务端解析
      const session = useSessionStore()
      this.pendingJoin = true
      this.ws.send({
        type: 'join',
        docId: session.docId,
        token: getToken(),
        lastRevision: this.joinedOnce ? this.ot.revision : undefined,
      })
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

  /** 进入文档：前置的 HTTP 权限加载已在调用方（workspace.openDoc）完成 */
  join(docId: string) {
    const session = useSessionStore()
    const workspace = useWorkspaceStore()
    session.docId = docId
    session.workspaceId = workspace.currentDoc?.workspaceId || ''
    session.docTitle = workspace.currentDoc?.title || docId
    session.name = useAuthStore().displayName
    session.joined = true
    this.joinedOnce = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws.connect(`${proto}://${location.host}/ws`)
  }

  leave() {
    this.ws.disconnect()
    this.ws.clearOutbox()
    this.joinedOnce = false
    this.pendingJoin = false
    useSessionStore().$reset()
    useDocStore().$reset()
    useWorkspaceStore().clearCurrentDoc()
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

  /* ---------------- 本地动作 ---------------- */

  /** 本地编辑：与当前文档 diff 生成操作，乐观应用并进入 OT 队列 */
  localEdit(newText: string) {
    const doc = useDocStore()
    const op = diffToOp(doc.text, newText)
    if (isNoop(op)) return
    doc.text = newText
    this.transformAnnotations(op)
    this.ot.localChange(op)
    doc.syncState = 'pending'
  }

  addAnnotation(start: number, end: number, quote: string, text: string) {
    this.ws.send({ type: 'ann:add', annId: genId('ann'), start, end, quote, text })
  }

  replyAnnotation(annId: string, text: string) {
    this.ws.send({ type: 'ann:reply', annId, replyId: genId('r'), text })
  }

  resolveAnnotation(annId: string, resolved: boolean) {
    this.ws.send({ type: 'ann:resolve', annId, resolved })
  }

  deleteAnnotation(annId: string) {
    this.ws.send({ type: 'ann:delete', annId })
  }

  /** 光标上报：120ms 节流，断线时直接丢弃（易失消息） */
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
        session.cursors[msg.clientId] = { start: msg.start, end: msg.end }
        break

      case 'perm:changed':
        this.onPermChanged(msg)
        break

      case 'doc:closed':
        this.handleDocClosed(msg.reason)
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
    this.pendingJoin = false
    // 角色以服务端下发为准（重连后权限可能已变化）
    session.role = msg.role
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
        ElMessage.warning('连接已恢复，但部分未同步的本地修改已回滚（版本过旧或权限不足）')
      } else if (wasRejoin) {
        ElMessage.success('已重新连接并同步到最新版本')
      }
    } else {
      // 增量：保留本地文档与未确认操作，批注先以服务端为准，ops 到达后再重放本地未确认操作
      doc.annotations = msg.annotations
      if (wasRejoin) ElMessage.success('连接已恢复，正在增量同步')
    }
  }

  /** 权限实时变更：更新门禁；失去编辑权时回滚在途的乐观修改 */
  private onPermChanged(msg: PermChangedMsg) {
    const session = useSessionStore()
    const oldRole: Role = session.role
    session.role = msg.role
    const workspace = useWorkspaceStore()
    if (workspace.permission) workspace.permission = { ...workspace.permission, role: msg.role }

    if (!canEdit(msg.role) && canEdit(oldRole)) {
      ElMessage.warning(msg.message || '你的编辑权限已被调整')
      // 编辑权被收回：丢弃尚未确认的本地编辑，并以服务端全量文档为准
      this.ws.clearOutbox()
      this.forceSnapshotResync()
    } else {
      ElMessage.info(msg.message || '文档权限已更新')
    }
  }

  /** 被移出文档 / 文档被删除：退出编辑器 */
  private handleDocClosed(reason: string) {
    ElMessage.warning(reason || '文档已关闭')
    const cb = this.onDocClosed
    this.leave()
    cb?.(reason)
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

  /** 强制全量快照重同步（lastRevision=-1 使服务端直接下发快照） */
  private forceSnapshotResync() {
    this.resyncing = true
    const doc = useDocStore()
    doc.syncState = 'resyncing'
    this.ot.rollback(this.ot.revision) // 丢弃所有未确认的乐观编辑
    this.ws.send({ type: 'resync', lastRevision: -1 })
  }

  private async onError(msg: ErrorMsg) {
    switch (msg.code) {
      case 'UNAUTHENTICATED':
        ElMessage.error(msg.message || '登录已失效，请重新登录')
        // 令牌失效：清除登录态并退出，回到登录页
        await useAuthStore().logout()
        this.handleDocClosed(msg.message || '登录已失效')
        break
      case 'PERMISSION_DENIED':
        if (msg.opId) {
          // 编辑操作被拒（如在途操作遭遇在线降权）：以服务端文档为准回滚本地乐观修改
          ElMessage.error(msg.message)
          this.forceSnapshotResync()
        } else if (this.pendingJoin) {
          // join 阶段被拒（首次进入或重连时已无权限）：退回工作台/登录页
          ElMessage.error(msg.message)
          const cb = this.onJoinRejected
          this.leave()
          cb?.(msg.message)
        } else {
          // 运行期批注等操作被拒（如离线期间被降权，队列补发失败）：仅提示
          ElMessage.error(msg.message)
        }
        break
      case 'NOT_FOUND':
        ElMessage.error(msg.message)
        this.handleDocClosed(msg.message)
        break
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
