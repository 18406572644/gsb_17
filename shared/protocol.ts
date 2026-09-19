/**
 * 客户端 / 服务端 WebSocket 协议定义。
 * 所有消息均为 JSON 文本帧，含 type 字段。
 */
import type { Op } from './ot'

/**
 * 文档角色（权限自低到高）：
 * - viewer    查看：只读，可见正文、批注、在线状态
 * - commenter 批注：在查看基础上可新增/回复/解决批注
 * - editor    编辑：在批注基础上可修改正文
 * - manager   管理：在编辑基础上可配置成员权限、查看审计（不参与协同语义外的操作）
 */
export type Role = 'viewer' | 'commenter' | 'editor' | 'manager'

/** 角色层级权重，数值越大权限越高 */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  manager: 3,
}

export const ROLE_LABEL: Record<Role, string> = {
  viewer: '查看',
  commenter: '批注',
  editor: '编辑',
  manager: '管理',
}

/** 可被授予的细粒度权限点 */
export type Permission = 'view' | 'comment' | 'edit' | 'manage'

export const PERMISSION_LABEL: Record<Permission, string> = {
  view: '查看',
  comment: '批注',
  edit: '编辑',
  manage: '管理',
}

/** 角色 → 其拥有的权限点 */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: ['view'],
  commenter: ['view', 'comment'],
  editor: ['view', 'comment', 'edit'],
  manager: ['view', 'comment', 'edit', 'manage'],
}

export function roleHas(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm)
}

export function canView(role: Role): boolean {
  return roleHas(role, 'view')
}

export function canEdit(role: Role): boolean {
  return roleHas(role, 'edit')
}

export function canAnnotate(role: Role): boolean {
  return roleHas(role, 'comment')
}

export function canManage(role: Role): boolean {
  return roleHas(role, 'manage')
}

/** 角色是否不弱于目标角色 */
export function roleAtLeast(role: Role, target: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[target]
}

/** 用户公开信息（在线列表 / 成员选择器使用） */
export interface UserInfo {
  /** 账号 ID（稳定标识；同一账号多标签在线时以此去重） */
  userId: string
  /** 当前 WebSocket 连接 ID（仅用于光标等连接级状态） */
  clientId: string
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
  workspaceId: string
  docId: string
  /** 登录后获得的会话令牌；服务端据此解析身份并鉴权 */
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
  workspaceId: string
  docId: string
  revision: number
  doc: string
  annotations: Annotation[]
  users: UserInfo[]
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
  /** 连接 ID（光标定位键） */
  clientId: string
  /** 账号 ID（用于着色 / 与在线列表匹配） */
  userId: string
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
 * 在线权限变更推送：管理员调整权限后实时下发给受影响用户的全部在线连接。
 * 客户端收到后立即更新本地角色、禁用对应能力；
 * 若降权导致存在未确认的越权编辑，需回滚并重同步。
 */
export interface PermissionUpdateMsg {
  type: 'perm:update'
  workspaceId: string
  docId: string
  /** 新的有效角色；null 表示权限被彻底收回 */
  role: Role | null
  /** 触发本次变更的管理员名（用于提示） */
  operatorName?: string
  /** 该消息独立即时处理，不参与文档 op 的 seq 可靠性流 */
  seq?: number
}

export type ServerErrorCode =
  | 'PERMISSION_DENIED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REVISION'
  | 'RESYNC_REQUIRED'
  | 'BAD_MESSAGE'
  | 'CONFLICT'
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
  | PermissionUpdateMsg
  | ErrorMsg
  | PongMsg
