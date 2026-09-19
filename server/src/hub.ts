/**
 * 会话注册表（Hub）：关联「账号身份 × WebSocket 连接 × 当前文档会话」。
 *
 * 职责：
 * - 维护 userId → 其全部在线连接（同一账号多标签 / 多设备）；
 * - 记录每条连接当前加入的工作区 / 文档及 DocSession；
 * - 权限在线调整时，定位受影响用户的相关连接，实时下发 perm:update，
 *   联动 DocSession 更新在线角色并广播 presence；
 * - 权限被彻底收回（或被移出工作区）时下发 perm:update(role=null) 并以
 *   4003 关闭连接，杜绝已无权者继续接收文档广播。
 *
 * 时序保证：Node 单线程串行处理 WS 消息，setUserRole 在降权推送的同一
 * 调用栈内完成，因此被降权用户「在途」（已到达 TCP 缓冲区、尚未处理）的
 * 下一条 op/批注消息一定会以新角色被逐条鉴权拦截。
 */
import type { WebSocket } from 'ws'
import type { Role } from '../../shared/protocol'
import type { DocSession } from './docSession'

export interface DocBinding {
  workspaceId: string
  docId: string
  session: DocSession
}

export interface HubConn {
  connId: string
  userId: string
  ws: WebSocket
  send: (msg: object) => void
  binding: DocBinding | null
  /** 已因权限收回被服务端关闭，避免重入清理 */
  closing: boolean
}

/** 权限收回时的关闭码（客户端据此停止自动重连并退回工作区首页） */
export const CLOSE_REVOKED = 4003

export class Hub {
  private conns = new Map<string, HubConn>()
  private byUser = new Map<string, Set<string>>()

  register(connId: string, userId: string, ws: WebSocket, send: (msg: object) => void): HubConn {
    const conn: HubConn = { connId, userId, ws, send, binding: null, closing: false }
    this.conns.set(connId, conn)
    let set = this.byUser.get(userId)
    if (!set) {
      set = new Set()
      this.byUser.set(userId, set)
    }
    set.add(connId)
    return conn
  }

  /** 绑定连接到已加入的文档会话 */
  bind(connId: string, binding: DocBinding) {
    const conn = this.conns.get(connId)
    if (conn) conn.binding = binding
  }

  get(connId: string) {
    return this.conns.get(connId)
  }

  userConns(userId: string): HubConn[] {
    const set = this.byUser.get(userId)
    if (!set) return []
    return [...set].map((id) => this.conns.get(id)!).filter(Boolean)
  }

  onlineUserCount(): number {
    return this.byUser.size
  }

  /**
   * 注销连接；若其仍在某文档会话中，执行会话摘除并由调用方广播 presence。
   * 返回被离开的绑定（已摘除则 null）。
   */
  unregister(connId: string): DocBinding | null {
    const conn = this.conns.get(connId)
    if (!conn) return null
    this.conns.delete(connId)
    const set = this.byUser.get(conn.userId)
    if (set) {
      set.delete(connId)
      if (set.size === 0) this.byUser.delete(conn.userId)
    }
    const binding = conn.binding
    if (binding) {
      binding.session.removeClient(connId)
      conn.binding = null
    }
    return binding
  }

  /**
   * 推送某用户在指定文档上的新权限。
   * role=null 表示权限被收回 → 关闭相关连接；否则更新会话角色并向该用户在
   * 该文档的全部连接广播 perm:update，再广播 presence。
   */
  pushDocRole(
    userId: string,
    workspaceId: string,
    docId: string,
    role: Role | null,
    operatorName?: string,
  ) {
    const conns = this.userConns(userId).filter(
      (c) => c.binding?.workspaceId === workspaceId && c.binding?.docId === docId,
    )
    if (conns.length === 0) return

    if (role === null) {
      for (const conn of conns) this.revokeConn(conn, workspaceId, docId, operatorName)
      return
    }

    // 按文档会话分组：每个会话只更新一次角色；若确有变化，通知该用户在该会话的全部连接
    const sessions = new Map<DocBinding['session'], HubConn[]>()
    for (const conn of conns) {
      const b = conn.binding!
      const list = sessions.get(b.session) ?? []
      list.push(conn)
      sessions.set(b.session, list)
    }
    for (const [session, list] of sessions) {
      if (!session.setUserRole(userId, role)) continue // 有效角色未变 → 不发冗余消息
      for (const conn of list) {
        conn.send({ type: 'perm:update', workspaceId, docId, role, operatorName })
      }
      session.broadcastAll({ type: 'presence', users: session.users() })
    }
  }

  /**
   * 用户被移出工作区 / 工作区被删除：关闭其绑定到该工作区任意文档的连接。
   */
  evictFromWorkspace(userId: string, workspaceId: string, operatorName?: string) {
    for (const conn of this.userConns(userId)) {
      const b = conn.binding
      if (b && b.workspaceId === workspaceId) {
        this.revokeConn(conn, workspaceId, b.docId, operatorName)
      }
    }
  }

  private revokeConn(conn: HubConn, workspaceId: string, docId: string, operatorName?: string) {
    if (conn.closing) return
    conn.closing = true
    try {
      conn.send({ type: 'perm:update', workspaceId, docId, role: null, operatorName })
    } catch {
      /* 连接可能已断开 */
    }
    try {
      conn.ws.close(CLOSE_REVOKED, 'permission revoked')
    } catch {
      /* ignore */
    }
    // 立即从文档会话摘除（不能依赖客户端响应 close），停止向其转发后续广播
    const binding = this.unregister(conn.connId)
    if (binding) {
      binding.session.broadcastAll({ type: 'presence', users: binding.session.users() })
    }
  }
}
