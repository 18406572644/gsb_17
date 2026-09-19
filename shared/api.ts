/**
 * 多租户 REST API 契约（服务端与客户端共享类型）。
 *
 * 认证：除 /api/auth/* 外，所有请求需带请求头 `Authorization: Bearer <token>`。
 * 令牌在登录 / 注册时由服务端签发。
 */
import type { Role } from './protocol'

/* ---------------- 领域模型 ---------------- */

export interface Account {
  id: string
  name: string
  /** 登录名（唯一），不返回密码 */
  username: string
  color: string
}

/** 工作区成员角色：admin 管理工作区与成员，member 为普通成员 */
export type WorkspaceRole = 'admin' | 'member'

export const WORKSPACE_ROLE_LABEL: Record<WorkspaceRole, string> = {
  admin: '工作区管理员',
  member: '成员',
}

export interface WorkspaceMember {
  userId: string
  name: string
  username: string
  color: string
  role: WorkspaceRole
}

export interface Workspace {
  id: string
  name: string
  /** 当前请求者在该工作区中的角色 */
  myRole: WorkspaceRole
  /** 成员数量 */
  memberCount: number
  docCount: number
  createdAt: number
}

/**
 * 文档成员权限配置。
 * 权限来源优先级：文档级显式授权 > 工作区角色（admin 恒为 manager）。
 * role 为 null 表示移除该文档的显式授权（回落到工作区级可见性）。
 */
export interface DocPermission {
  userId: string
  name: string
  username: string
  color: string
  /** 显式授予的文档角色；未显式授权的成员不出现（admin 除外，恒 manager） */
  role: Role
  /** 是否来自工作区管理员的隐式提权（admin → manager），用于 UI 标记 */
  implicit?: boolean
}

export interface DocMeta {
  id: string
  workspaceId: string
  title: string
  updatedAt: number
  createdAt: number
  /** 当前请求者对该文档的有效角色；null 表示无权限（列表中不会出现） */
  myRole: Role
}

/** 权限变更审计条目（文档级授权与工作区成员角色变更均记录） */
export interface AuditEntry {
  id: string
  workspaceId: string
  /** 'doc-permission' 文档级查看/批注/编辑/管理授权；'workspace-role' 工作区成员角色变更 */
  kind: 'doc-permission' | 'workspace-role'
  /** 工作区级事件时省略 */
  docId?: string
  docTitle?: string
  /** 被变更权限的用户 */
  targetUserId: string
  targetUserName: string
  /** 变更前角色（文档事件为 Role，工作区事件为 WorkspaceRole）；null 表示原本无权限/被移除 */
  fromRole: string | null
  /** 变更后角色；null 表示权限被收回 */
  toRole: string | null
  operatorId: string
  operatorName: string
  createdAt: number
}

/** 最近协作文档（首页展示） */
export interface RecentDoc {
  doc: DocMeta
  lastVisitedAt: number
}

/* ---------------- 认证 ---------------- */

export interface LoginRequest {
  username: string
  password: string
}

export interface RegisterRequest {
  username: string
  password: string
  name: string
}

export interface AuthResponse {
  token: string
  account: Account
}

/* ---------------- 工作区 ---------------- */

export interface CreateWorkspaceRequest {
  name: string
}

export interface AddMemberRequest {
  username: string
  role: WorkspaceRole
}

export interface UpdateMemberRoleRequest {
  role: WorkspaceRole
}

/* ---------------- 文档 ---------------- */

export interface CreateDocRequest {
  title: string
}

/**
 * 配置某用户对某文档的权限。
 * role=null 表示移除显式授权。仅文档 manager（通常是工作区 admin）可调用。
 */
export interface SetDocPermissionRequest {
  userId: string
  role: Role | null
}

/* ---------------- 聚合响应 ---------------- */

/** 工作区详情：成员 + 文档目录 */
export interface WorkspaceDetail {
  workspace: Workspace
  members: WorkspaceMember[]
  docs: DocMeta[]
}

/** 文档权限详情：权限列表 + 可授权的工作区成员 */
export interface DocPermissionList {
  doc: DocMeta
  /** 当前已确定的有效权限（含 admin 隐式 manager） */
  permissions: DocPermission[]
  /** 审计记录（最新在前） */
  audit: AuditEntry[]
}

/** 首页聚合：可访问工作区 + 最近协作文档 */
export interface HomeData {
  account: Account
  workspaces: Workspace[]
  recent: RecentDoc[]
}

/** 加入文档前的权限预加载（客户端进入编辑器前调用） */
export interface DocBoot {
  doc: DocMeta
  role: Role
  workspaceId: string
  /** 同文档在线协作者（快照，实时变化走 WS presence） */
  onlineUsers: { userId: string; name: string; color: string; role: Role }[]
}

/* ---------------- REST 错误 ---------------- */

export interface ApiErrorBody {
  error: string
  message: string
}
