/**
 * 客户端 / 服务端 WebSocket 协议定义。
 * 所有消息均为 JSON 文本帧，含 type 字段。
 */
import type { Op } from './ot'

/**
 * 文档级角色（细粒度权限）：
 * viewer 查看 / commenter 批注 / editor 编辑+批注 / admin 管理（含成员授权，默认兼具编辑权）。
 * 工作区级角色（admin/member）见 tenant.ts。
 */
export type Role = 'viewer' | 'commenter' | 'editor' | 'admin'

export const ROLE_LABEL: Record<Role, string> = {
  viewer: '只读',
  commenter: '批注',
  editor: '编辑',
  admin: '管理',
}

/** 角色等级，可比较权限高低（成员管理下拉按此排序） */
export const ROLE_LEVEL: Record<Role, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  admin: 3,
}

export function canEdit(role: Role): boolean {
  return role === 'editor' || role === 'admin'
}

export function canAnnotate(role: Role): boolean {
  return role === 'editor' || role === 'commenter' || role === 'admin'
}

/** 管理权限：配置文档成员、查看审计等 */
export function canManage(role: Role): boolean {
  return role === 'admin'
}

export interface UserInfo {
  clientId: string
  /** 稳定的用户 ID（权限实时变更按此匹配在线连接） */
  userId: string
  name: string
  role: Role
  color: string
}

export interface Reply {
  id: string
  authorId: string
  authorName: string
  text: string
  createdAt: number
}

/** 批注锚定到文档的 [start, end) 区间，随编辑操作做位置映射 */
export interface Annotation {
  id: string
  start: number
  end: number
  /** 锚点文本被完全删除后为 true（孤儿批注，折叠到 start 处展示） */
  orphan: boolean
  quote: string
  authorId: string
  authorName: string
  text: string
  replies: Reply[]
  resolved: boolean
  createdAt: number
}

export interface LogEntry {
  revision: number
  op: Op
  opId: string
  clientId: string
  authorName: string
  /** 应用该操作前的文档长度（用于校验客户端操作的基准版本） */
  lenBefore: number
}

/* ---------------- 客户端 → 服务端 ---------------- */

export interface JoinMsg {
  type: 'join'
  docId: string
  /** 登录令牌；服务端据此解析用户身份与文档权限，角色不再由客户端自选 */
  token: string
  /** 断线重连时携带本地已同步到的版本号，用于增量补齐 */
  lastRevision?: number
}

export interface OpMsg {
  type: 'op'
  revision: number
  op: Op
  opId: string
}

export interface CursorMsg {
  type: 'cursor'
  start: number
  end: number
}

export interface AnnAddMsg {
  type: 'ann:add'
  annId: string
  start: number
  end: number
  quote: string
  text: string
}

export interface AnnReplyMsg {
  type: 'ann:reply'
  annId: string
  replyId: string
  text: string
}

export interface AnnResolveMsg {
  type: 'ann:resolve'
  annId: string
  resolved: boolean
}

export interface AnnDeleteMsg {
  type: 'ann:delete'
  annId: string
}

/** 主动请求重同步（检测到消息空洞 / ack 超时 / 收到 RESYNC 错误时） */
export interface ResyncMsg {
  type: 'resync'
  lastRevision: number
}

export interface PingMsg {
  type: 'ping'
  t: number
}

export type ClientMsg =
  | JoinMsg
  | OpMsg
  | CursorMsg
  | AnnAddMsg
  | AnnReplyMsg
  | AnnResolveMsg
  | AnnDeleteMsg
  | ResyncMsg
  | PingMsg

/* ---------------- 服务端 → 客户端 ---------------- */

export interface WelcomeMsg {
  type: 'welcome'
  clientId: string
  userId: string
  docId: string
  workspaceId: string
  revision: number
  doc: string
  annotations: Annotation[]
  users: UserInfo[]
  /** 服务端根据成员关系解析出的当前用户有效角色 */
  role: Role
  /** 重连时若 true 表示服务端日志已不足以增量补齐，本消息为全量快照 */
  snapshot: boolean
  /** 当前文档广播序号，客户端据此检测后续消息空洞 */
  seq: number
}

/** 增量补齐：重连后补发错过的操作 */
export interface OpsMsg {
  type: 'ops'
  ops: { revision: number; op: Op; opId: string; clientId: string; authorName: string }[]
  revision: number
  seq: number
}

export interface AckMsg {
  type: 'ack'
  opId: string
  revision: number
  /** 与他人收到的 op 广播使用同一序号，保证所有客户端的 seq 流一致 */
  seq: number
}

/** 他人操作广播（不发给操作发起者，发起者收 ack） */
export interface RemoteOpMsg {
  type: 'op'
  revision: number
  op: Op
  opId: string
  clientId: string
  authorName: string
  seq: number
}

export interface PresenceMsg {
  type: 'presence'
  users: UserInfo[]
}

export interface RemoteCursorMsg {
  type: 'cursor'
  clientId: string
  start: number
  end: number
}

export interface AnnUpsertMsg {
  type: 'ann:upsert'
  ann: Annotation
  seq: number
}

export interface AnnDeletedMsg {
  type: 'ann:delete'
  annId: string
  seq: number
}

/**
 * 权限实时变更推送：管理员调整某用户在当前文档的角色后，
 * 服务端立即推送给该用户的所有在线连接（不占 seq，类似 presence 的易失消息）。
 * 客户端收到后立即更新权限门禁；若失去编辑权，还需重同步以回滚在途的乐观修改。
 */
export interface PermChangedMsg {
  type: 'perm:changed'
  docId: string
  role: Role
  message: string
}

/** 文档被删除或当前用户被移除：在线连接收到后应退出编辑器回到工作台 */
export interface DocClosedMsg {
  type: 'doc:closed'
  docId: string
  reason: string
}

export type ServerErrorCode =
  | 'PERMISSION_DENIED'
  | 'UNAUTHENTICATED'
  | 'BAD_REVISION'
  | 'RESYNC_REQUIRED'
  | 'BAD_MESSAGE'
  | 'NOT_FOUND'
  | 'INTERNAL'

export interface ErrorMsg {
  type: 'error'
  code: ServerErrorCode
  message: string
  opId?: string
}

export interface PongMsg {
  type: 'pong'
  t: number
}

export type ServerMsg =
  | WelcomeMsg
  | OpsMsg
  | AckMsg
  | RemoteOpMsg
  | PresenceMsg
  | RemoteCursorMsg
  | AnnUpsertMsg
  | AnnDeletedMsg
  | PermChangedMsg
  | DocClosedMsg
  | ErrorMsg
  | PongMsg
