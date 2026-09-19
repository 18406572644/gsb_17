/**
 * 多租户领域模型：用户 / 工作区 / 文档 / 成员权限 / 审计。
 * 客户端与服务端共享这些类型；HTTP API 的请求/响应结构也定义在此。
 */
import type { Role } from './protocol'

/* ---------------- 实体 ---------------- */

export interface User {
  id: string
  /** 登录名（唯一） */
  username: string
  displayName: string
  createdAt: number
}

/** 工作区级角色：admin 可管理工作区成员与全部文档，member 为普通成员 */
export type WorkspaceRole = 'admin' | 'member'

export interface Workspace {
  id: string
  name: string
  description: string
  createdAt: number
}

export interface WorkspaceMembership {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  createdAt: number
}

export interface WorkspaceDoc {
  id: string
  workspaceId: string
  title: string
  createdBy: string
  createdAt: number
  updatedAt: number
}

/** 文档级细粒度角色：查看 / 批注 / 编辑 / 管理 */
export type DocRole = Role

export interface DocMember {
  docId: string
  userId: string
  role: DocRole
  grantedBy: string
  grantedAt: number
}

/** 权限变更 / 文档管理操作的审计记录 */
export interface AuditEntry {
  id: string
  workspaceId: string
  docId?: string
  actorId: string
  actorName: string
  /** 动作，如 doc.create / member.grant / member.update / member.remove */
  action: string
  targetType: 'doc' | 'member' | 'workspace'
  targetId?: string
  /** 人类可读的变更详情（含旧值/新值） */
  detail: string
  at: number
}

/** 最近协作文档（按用户记录） */
export interface RecentDoc {
  docId: string
  workspaceId: string
  title: string
  lastOpenedAt: number
}

/* ---------------- 权限视图 ---------------- */

export interface DocPermission {
  role: DocRole
  canView: boolean
  canComment: boolean
  canEdit: boolean
  canAdmin: boolean
}

/** 由文档角色派生四个细粒度权限位（admin 兼具查看/批注/编辑/管理） */
export function permissionOf(role: DocRole): DocPermission {
  return {
    role,
    canView: true,
    canComment: role === 'commenter' || role === 'editor' || role === 'admin',
    canEdit: role === 'editor' || role === 'admin',
    canAdmin: role === 'admin',
  }
}

/** 成员记录 + 对应用户信息（成员管理列表） */
export interface DocMemberView {
  userId: string
  user: User
  role: DocRole
  grantedBy: string
  grantedAt: number
}

export interface WorkspaceMemberView {
  userId: string
  user: User
  role: WorkspaceRole
  createdAt: number
}

/* ---------------- HTTP DTO ---------------- */

export interface RegisterRequest {
  username: string
  password: string
  displayName?: string
}

export interface LoginRequest {
  username: string
  password: string
}

export interface AuthResponse {
  token: string
  user: User
}

export interface WorkspaceListItem {
  workspace: Workspace
  role: WorkspaceRole
  docCount: number
}

export interface WorkspaceDetail {
  workspace: Workspace
  role: WorkspaceRole
  members: WorkspaceMemberView[]
}

/** 目录中文档 + 当前用户在该文档上的角色（null 表示尚未被授权） */
export interface DocListItem {
  doc: WorkspaceDoc
  role: DocRole | null
}

export interface CreateWorkspaceRequest {
  name: string
  description?: string
}

export interface AddWorkspaceMemberRequest {
  username: string
  role?: WorkspaceRole
}

export interface UpdateWorkspaceMemberRequest {
  role: WorkspaceRole
}

export interface CreateDocRequest {
  title: string
  initialContent?: string
}

export interface UpdateDocRequest {
  title?: string
}

export interface GrantDocMemberRequest {
  username: string
  role: DocRole
}

export interface DocDetailResponse {
  doc: WorkspaceDoc
  workspace: Workspace
  /** 当前用户在该文档上的有效角色 */
  role: DocRole
  permission: DocPermission
  members: DocMemberView[]
}

export interface AuditResponse {
  entries: AuditEntry[]
}

export interface RecentResponse {
  recent: RecentDoc[]
}

/** 标准错误响应 */
export interface ApiErrorBody {
  error: string
  message: string
}
