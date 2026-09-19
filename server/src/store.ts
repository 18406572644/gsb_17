/**
 * 多租户数据层：用户、工作区、工作区成员、文档、文档成员（细粒度权限）、
 * 最近协作文档、权限变更审计。
 *
 * 单进程内存态 + 单个 JSON 快照（tenants.json，防抖落盘）；
 * 登录令牌仅保存在内存中（服务端重启需重新登录）。
 * 文档正文仍由 DocSession 独立持久化（data/<docId>.json）。
 */
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  AuditEntry,
  DocMember,
  DocMemberView,
  DocRole,
  RecentDoc,
  User,
  Workspace,
  WorkspaceDoc,
  WorkspaceMemberView,
  WorkspaceMembership,
  WorkspaceRole,
} from '../../shared/tenant'

/** HTTP / 业务错误：带 HTTP 状态码与错误码 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface StoredUser extends User {
  salt: string
  hash: string
}

interface TokenInfo {
  userId: string
  createdAt: number
}

interface DBShape {
  users: StoredUser[]
  workspaces: Workspace[]
  memberships: WorkspaceMembership[]
  docs: WorkspaceDoc[]
  docMembers: DocMember[]
  recent: Record<string, RecentDoc[]>
  audit: AuditEntry[]
}

const RECENT_LIMIT = 20
const AUDIT_LIMIT = 5000

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

function verifyPassword(password: string, salt: string, hash: string): boolean {
  const got = Buffer.from(hashPassword(password, salt), 'hex')
  const want = Buffer.from(hash, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

function validUsername(name: string): boolean {
  return /^[a-zA-Z0-9_-]{3,20}$/.test(name)
}

export class TenantStore {
  private users = new Map<string, StoredUser>()
  private usersByName = new Map<string, string>()
  private workspaces = new Map<string, Workspace>()
  /** workspaceId → (userId → membership) */
  private memberships = new Map<string, Map<string, WorkspaceMembership>>()
  private docs = new Map<string, WorkspaceDoc>()
  /** docId → (userId → DocMember) */
  private docMembers = new Map<string, Map<string, DocMember>>()
  private recent = new Map<string, RecentDoc[]>()
  private audit: AuditEntry[] = []
  private tokens = new Map<string, TokenInfo>()

  /** 权限变更通知钩子（index.ts 接入后实时推送在线连接） */
  onPermissionChange:
    | ((e: { docId: string; workspaceId: string; userId: string; role: DocRole | null }) => void)
    | null = null
  /** 文档删除通知钩子 */
  onDocDelete: ((e: { docId: string; workspaceId: string }) => void) | null = null

  private constructor(private readonly file: string) {}

  /* ---------------- 持久化 ---------------- */

  static load(file: string): TenantStore {
    const store = new TenantStore(file)
    if (existsSync(file)) {
      try {
        const db = JSON.parse(readFileSync(file, 'utf8')) as DBShape
        for (const u of db.users || []) {
          store.users.set(u.id, u)
          store.usersByName.set(u.username.toLowerCase(), u.id)
        }
        for (const w of db.workspaces || []) store.workspaces.set(w.id, w)
        for (const m of db.memberships || []) {
          if (!store.memberships.has(m.workspaceId)) store.memberships.set(m.workspaceId, new Map())
          store.memberships.get(m.workspaceId)!.set(m.userId, m)
        }
        for (const d of db.docs || []) store.docs.set(d.id, d)
        for (const dm of db.docMembers || []) {
          if (!store.docMembers.has(dm.docId)) store.docMembers.set(dm.docId, new Map())
          store.docMembers.get(dm.docId)!.set(dm.userId, dm)
        }
        for (const [uid, list] of Object.entries(db.recent || {})) store.recent.set(uid, list)
        store.audit = db.audit || []
      } catch (e) {
        console.error('[tenant] 租户数据恢复失败，将重新初始化:', e)
        store.reset()
      }
    }
    if (store.users.size === 0) store.seed()
    return store
  }

  private persistTimer: NodeJS.Timeout | null = null

  /** 防抖落盘（与 DocSession 的持久化节奏一致） */
  save() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      try {
        writeFileSync(this.file, JSON.stringify(this.toJSON(), null, 2))
      } catch (e) {
        console.error('[tenant] 写入失败:', e)
      }
    }, 500)
  }

  /** 进程退出时同步刷盘 */
  flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    writeFileSync(this.file, JSON.stringify(this.toJSON(), null, 2))
  }

  private toJSON(): DBShape {
    return {
      users: [...this.users.values()].map(({ salt, hash, ...u }) => ({ ...u, salt, hash })),
      workspaces: [...this.workspaces.values()],
      memberships: [...this.memberships.values()].flatMap((m) => [...m.values()]),
      docs: [...this.docs.values()],
      docMembers: [...this.docMembers.values()].flatMap((m) => [...m.values()]),
      recent: Object.fromEntries(this.recent),
      audit: this.audit,
    }
  }

  /* ---------------- 种子数据 ---------------- */

  private seed() {
    const mkUser = (username: string, password: string, displayName: string): StoredUser => {
      const salt = randomUUID()
      const u: StoredUser = {
        id: `user-${username}`,
        username,
        displayName,
        createdAt: Date.now(),
        salt,
        hash: hashPassword(password, salt),
      }
      this.users.set(u.id, u)
      this.usersByName.set(username.toLowerCase(), u.id)
      return u
    }
    const admin = mkUser('admin', 'admin123', '空间管理员')
    const editor = mkUser('editor', 'editor123', '编辑员小王')
    const commenter = mkUser('commenter', 'commenter123', '批注员小李')
    const viewer = mkUser('viewer', 'viewer123', '只读访客')

    const ws: Workspace = {
      id: 'demo-ws',
      name: '演示企业工作区',
      description: '用于体验多文档工作区、细粒度成员权限与实时降权拦截',
      createdAt: Date.now(),
    }
    this.workspaces.set(ws.id, ws)
    const memberMap = new Map<string, WorkspaceMembership>()
    const addMember = (u: StoredUser, role: WorkspaceRole) => {
      memberMap.set(u.id, { workspaceId: ws.id, userId: u.id, role, createdAt: Date.now() })
    }
    addMember(admin, 'admin')
    addMember(editor, 'member')
    addMember(commenter, 'member')
    addMember(viewer, 'member')
    this.memberships.set(ws.id, memberMap)

    const doc: WorkspaceDoc = {
      id: 'demo',
      workspaceId: ws.id,
      title: '多人协同批注编辑器（演示文档）',
      createdBy: admin.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.docs.set(doc.id, doc)
    const dm = new Map<string, DocMember>()
    const grant = (u: StoredUser, role: DocRole) => {
      dm.set(u.id, { docId: doc.id, userId: u.id, role, grantedBy: admin.id, grantedAt: Date.now() })
    }
    grant(admin, 'admin')
    grant(editor, 'editor')
    grant(commenter, 'commenter')
    grant(viewer, 'viewer')
    this.docMembers.set(doc.id, dm)

    this.writeAudit({
      workspaceId: ws.id,
      docId: doc.id,
      actorId: admin.id,
      action: 'system.seed',
      targetType: 'workspace',
      detail: '初始化演示工作区与示例账号',
    })
    this.save()
  }

  private reset() {
    this.users.clear()
    this.usersByName.clear()
    this.workspaces.clear()
    this.memberships.clear()
    this.docs.clear()
    this.docMembers.clear()
    this.recent.clear()
    this.audit = []
  }

  /* ---------------- 认证 ---------------- */

  register(username: string, password: string, displayName?: string): User {
    const uname = username.trim()
    if (!validUsername(uname)) throw new ApiError(400, 'BAD_REQUEST', '登录名需为 3-20 位字母、数字、下划线或连字符')
    if (!password || password.length < 6) throw new ApiError(400, 'BAD_REQUEST', '密码至少 6 位')
    if (this.usersByName.has(uname.toLowerCase())) {
      throw new ApiError(409, 'CONFLICT', '该登录名已被注册')
    }
    const salt = randomUUID()
    const user: StoredUser = {
      id: `user-${randomUUID()}`,
      username: uname,
      displayName: (displayName || '').trim().slice(0, 24) || uname,
      createdAt: Date.now(),
      salt,
      hash: hashPassword(password, salt),
    }
    this.users.set(user.id, user)
    this.usersByName.set(uname.toLowerCase(), user.id)
    this.save()
    return this.publicUser(user)
  }

  login(username: string, password: string): { token: string; user: User } {
    const user = this.users.get(this.usersByName.get(username.trim().toLowerCase()) || '')
    if (!user || !verifyPassword(password, user.salt, user.hash)) {
      throw new ApiError(401, 'UNAUTHENTICATED', '登录名或密码错误')
    }
    const token = randomUUID()
    this.tokens.set(token, { userId: user.id, createdAt: Date.now() })
    return { token, user: this.publicUser(user) }
  }

  logout(token: string) {
    this.tokens.delete(token)
  }

  /** 令牌 → 用户（WS 与 HTTP 共用的身份解析入口） */
  userFromToken(token: string): User {
    const info = this.tokens.get(token)
    if (!info) throw new ApiError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录')
    const user = this.users.get(info.userId)
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', '用户不存在')
    return this.publicUser(user)
  }

  requireUser(userId: string): User {
    const u = this.users.get(userId)
    if (!u) throw new ApiError(404, 'NOT_FOUND', '用户不存在')
    return this.publicUser(u)
  }

  private userByUsername(username: string): StoredUser | undefined {
    return this.users.get(this.usersByName.get(username.trim().toLowerCase()) || '')
  }

  private publicUser(u: StoredUser): User {
    return { id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt }
  }

  /* ---------------- 工作区 ---------------- */

  listWorkspaces(userId: string) {
    const result: { workspace: Workspace; role: WorkspaceRole; docCount: number }[] = []
    for (const [wsId, map] of this.memberships) {
      const m = map.get(userId)
      if (!m) continue
      const ws = this.workspaces.get(wsId)!
      result.push({ workspace: ws, role: m.role, docCount: this.countAccessibleDocs(wsId, userId) })
    }
    return result.sort((a, b) => a.workspace.createdAt - b.workspace.createdAt)
  }

  private getMembership(workspaceId: string, userId: string): WorkspaceMembership {
    const m = this.memberships.get(workspaceId)?.get(userId)
    if (!m) throw new ApiError(403, 'PERMISSION_DENIED', '你不是该工作区成员')
    return m
  }

  requireWorkspaceAdmin(workspaceId: string, userId: string): WorkspaceMembership {
    const m = this.getMembership(workspaceId, userId)
    if (m.role !== 'admin') throw new ApiError(403, 'PERMISSION_DENIED', '需要工作区管理员权限')
    return m
  }

  isWorkspaceAdmin(workspaceId: string, userId: string): boolean {
    return this.memberships.get(workspaceId)?.get(userId)?.role === 'admin'
  }

  getWorkspaceDetail(userId: string, workspaceId: string) {
    const membership = this.getMembership(workspaceId, userId)
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw new ApiError(404, 'NOT_FOUND', '工作区不存在')
    return { workspace, role: membership.role, members: this.listWorkspaceMembers(workspaceId) }
  }

  listWorkspaceMembers(workspaceId: string): WorkspaceMemberView[] {
    const map = this.memberships.get(workspaceId)
    if (!map) return []
    return [...map.values()]
      .map((m) => ({ userId: m.userId, user: this.requireUser(m.userId), role: m.role, createdAt: m.createdAt }))
      .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName))
  }

  createWorkspace(userId: string, name: string, description?: string): Workspace {
    const trimmed = name.trim()
    if (!trimmed) throw new ApiError(400, 'BAD_REQUEST', '工作区名称不能为空')
    const ws: Workspace = {
      id: `ws-${randomUUID()}`,
      name: trimmed.slice(0, 50),
      description: (description || '').trim().slice(0, 200),
      createdAt: Date.now(),
    }
    this.workspaces.set(ws.id, ws)
    this.memberships.set(
      ws.id,
      new Map([[userId, { workspaceId: ws.id, userId, role: 'admin', createdAt: Date.now() }]]),
    )
    this.writeAudit({
      workspaceId: ws.id,
      actorId: userId,
      action: 'workspace.create',
      targetType: 'workspace',
      targetId: ws.id,
      detail: `创建工作区「${ws.name}」`,
    })
    this.save()
    return ws
  }

  addWorkspaceMember(actorId: string, workspaceId: string, username: string, role: WorkspaceRole = 'member') {
    this.requireWorkspaceAdmin(workspaceId, actorId)
    const user = this.userByUsername(username)
    if (!user) throw new ApiError(404, 'NOT_FOUND', '用户不存在，请先让对方注册账号')
    const map = this.memberships.get(workspaceId)!
    if (map.has(user.id)) throw new ApiError(409, 'CONFLICT', '该用户已是工作区成员')
    const m: WorkspaceMembership = { workspaceId, userId: user.id, role, createdAt: Date.now() }
    map.set(user.id, m)
    this.writeAudit({
      workspaceId,
      actorId,
      action: 'workspace.member.add',
      targetType: 'member',
      targetId: user.id,
      detail: `添加成员 ${user.displayName}（${role === 'admin' ? '管理员' : '普通成员'}）`,
    })
    this.save()
    return { userId: user.id, user: this.publicUser(user), role, createdAt: m.createdAt }
  }

  updateWorkspaceMember(actorId: string, workspaceId: string, targetUserId: string, role: WorkspaceRole) {
    this.requireWorkspaceAdmin(workspaceId, actorId)
    const map = this.memberships.get(workspaceId)!
    const m = map.get(targetUserId)
    if (!m) throw new ApiError(404, 'NOT_FOUND', '成员不存在')
    if (targetUserId === actorId) throw new ApiError(400, 'BAD_REQUEST', '不能修改自己的工作区角色')
    const oldRole = m.role
    m.role = role
    this.writeAudit({
      workspaceId,
      actorId,
      action: 'workspace.member.update',
      targetType: 'member',
      targetId: targetUserId,
      detail: `${this.requireUser(targetUserId).displayName}：${oldRole} → ${role}`,
    })
    this.save()
    // 工作区管理员隐式拥有区内全部文档管理权：角色变更后同步在线文档会话
    for (const doc of this.docs.values()) {
      if (doc.workspaceId !== workspaceId) continue
      this.onPermissionChange?.({
        docId: doc.id,
        workspaceId,
        userId: targetUserId,
        role: this.resolveDocRole(doc.id, targetUserId),
      })
    }
  }

  removeWorkspaceMember(actorId: string, workspaceId: string, targetUserId: string) {
    this.requireWorkspaceAdmin(workspaceId, actorId)
    const map = this.memberships.get(workspaceId)!
    if (!map.has(targetUserId)) throw new ApiError(404, 'NOT_FOUND', '成员不存在')
    if (targetUserId === actorId) throw new ApiError(400, 'BAD_REQUEST', '不能移除自己，请转交管理权后退出')
    // 级联移除该工作区下所有文档成员授权
    for (const doc of this.docs.values()) {
      if (doc.workspaceId !== workspaceId) continue
      this.docMembers.get(doc.id)?.delete(targetUserId)
      this.onPermissionChange?.({ docId: doc.id, workspaceId, userId: targetUserId, role: null })
    }
    const name = this.requireUser(targetUserId).displayName
    map.delete(targetUserId)
    this.writeAudit({
      workspaceId,
      actorId,
      action: 'workspace.member.remove',
      targetType: 'member',
      targetId: targetUserId,
      detail: `移除工作区成员 ${name}`,
    })
    this.save()
  }

  /* ---------------- 文档目录 ---------------- */

  private countAccessibleDocs(workspaceId: string, userId: string): number {
    let n = 0
    for (const d of this.docs.values()) {
      if (d.workspaceId === workspaceId && this.resolveDocRole(d.id, userId)) n++
    }
    return n
  }

  /** 列出工作区内当前用户可见的文档（显式授权，或工作区管理员隐式可见） */
  listDocs(workspaceId: string, userId: string) {
    this.getMembership(workspaceId, userId)
    const items: { doc: WorkspaceDoc; role: DocRole | null }[] = []
    for (const doc of this.docs.values()) {
      if (doc.workspaceId !== workspaceId) continue
      const role = this.resolveDocRole(doc.id, userId)
      if (role) items.push({ doc, role })
    }
    return items.sort((a, b) => b.doc.updatedAt - a.doc.updatedAt)
  }

  /** 当前用户在文档上的有效角色：显式文档授权优先，工作区管理员隐式拥有管理权 */
  resolveDocRole(docId: string, userId: string): DocRole | null {
    const doc = this.docs.get(docId)
    if (!doc) return null
    const explicit = this.docMembers.get(docId)?.get(userId)?.role
    if (explicit) return explicit
    if (this.isWorkspaceAdmin(doc.workspaceId, userId)) return 'admin'
    return null
  }

  requireDoc(docId: string): WorkspaceDoc {
    const doc = this.docs.get(docId)
    if (!doc) throw new ApiError(404, 'NOT_FOUND', '文档不存在或已被删除')
    return doc
  }

  /** 进入文档前的统一鉴权：返回文档与有效角色 */
  resolveDocForUser(docId: string, userId: string): { doc: WorkspaceDoc; role: DocRole } {
    const doc = this.requireDoc(docId)
    this.getMembership(doc.workspaceId, userId)
    const role = this.resolveDocRole(docId, userId)
    if (!role) throw new ApiError(403, 'PERMISSION_DENIED', '你没有该文档的访问权限')
    return { doc, role }
  }

  createDoc(actorId: string, workspaceId: string, title: string): WorkspaceDoc {
    this.getMembership(workspaceId, actorId)
    const trimmed = title.trim()
    if (!trimmed) throw new ApiError(400, 'BAD_REQUEST', '文档标题不能为空')
    const doc: WorkspaceDoc = {
      id: `doc-${randomUUID()}`,
      workspaceId,
      title: trimmed.slice(0, 100),
      createdBy: actorId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.docs.set(doc.id, doc)
    this.docMembers.set(
      doc.id,
      new Map([[actorId, { docId: doc.id, userId: actorId, role: 'admin', grantedBy: actorId, grantedAt: Date.now() }]]),
    )
    this.writeAudit({
      workspaceId,
      docId: doc.id,
      actorId,
      action: 'doc.create',
      targetType: 'doc',
      targetId: doc.id,
      detail: `创建文档「${doc.title}」`,
    })
    this.save()
    return doc
  }

  renameDoc(actorId: string, docId: string, title: string): WorkspaceDoc {
    const doc = this.requireDoc(docId)
    const role = this.resolveDocRole(docId, actorId)
    if (role !== 'admin') throw new ApiError(403, 'PERMISSION_DENIED', '仅文档管理员可重命名')
    const old = doc.title
    doc.title = title.trim().slice(0, 100) || old
    doc.updatedAt = Date.now()
    this.writeAudit({
      workspaceId: doc.workspaceId,
      docId,
      actorId,
      action: 'doc.rename',
      targetType: 'doc',
      targetId: docId,
      detail: `重命名：「${old}」→「${doc.title}」`,
    })
    this.save()
    return doc
  }

  deleteDoc(actorId: string, docId: string) {
    const doc = this.requireDoc(docId)
    const role = this.resolveDocRole(docId, actorId)
    if (role !== 'admin') throw new ApiError(403, 'PERMISSION_DENIED', '仅文档管理员可删除文档')
    this.docs.delete(docId)
    this.docMembers.delete(docId)
    for (const list of this.recent.values()) {
      const i = list.findIndex((r) => r.docId === docId)
      if (i >= 0) list.splice(i, 1)
    }
    this.writeAudit({
      workspaceId: doc.workspaceId,
      docId,
      actorId,
      action: 'doc.delete',
      targetType: 'doc',
      targetId: docId,
      detail: `删除文档「${doc.title}」`,
    })
    this.save()
    this.onDocDelete?.({ docId, workspaceId: doc.workspaceId })
  }

  /* ---------------- 文档成员 / 细粒度权限 ---------------- */

  listDocMembers(docId: string, actorId: string): DocMemberView[] {
    this.requireDoc(docId)
    const role = this.resolveDocRole(docId, actorId)
    if (!role) throw new ApiError(403, 'PERMISSION_DENIED', '你没有该文档的访问权限')
    return [...(this.docMembers.get(docId)?.values() || [])]
      .map((dm) => ({
        userId: dm.userId,
        user: this.requireUser(dm.userId),
        role: dm.role,
        grantedBy: dm.grantedBy,
        grantedAt: dm.grantedAt,
      }))
      .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName))
  }

  private requireDocAdmin(docId: string, actorId: string): WorkspaceDoc {
    const doc = this.requireDoc(docId)
    if (this.resolveDocRole(docId, actorId) !== 'admin') {
      throw new ApiError(403, 'PERMISSION_DENIED', '仅文档管理员可配置成员权限')
    }
    return doc
  }

  /** 授权 / 调整角色（按用户名），变更后触发实时通知钩子 */
  grantDocMember(actorId: string, docId: string, username: string, role: DocRole): DocMemberView {
    const doc = this.requireDocAdmin(docId, actorId)
    const target = this.userByUsername(username)
    if (!target) throw new ApiError(404, 'NOT_FOUND', '用户不存在，请先让对方注册账号')
    this.getMembership(doc.workspaceId, target.id) // 必须是同工作区成员
    let map = this.docMembers.get(docId)
    if (!map) {
      map = new Map()
      this.docMembers.set(docId, map)
    }
    if (target.id === actorId && role !== 'admin') {
      throw new ApiError(400, 'BAD_REQUEST', '不能降低自己的管理角色，请由其他管理员操作')
    }
    const existing = map.get(target.id)
    if (existing) {
      const oldRole = existing.role
      if (oldRole === role) throw new ApiError(409, 'CONFLICT', '该成员已是此角色')
      existing.role = role
      existing.grantedBy = actorId
      existing.grantedAt = Date.now()
      this.writeAudit({
        workspaceId: doc.workspaceId,
        docId,
        actorId,
        action: 'member.update',
        targetType: 'member',
        targetId: target.id,
        detail: `${target.displayName} 权限调整：${oldRole} → ${role}`,
      })
    } else {
      map.set(target.id, { docId, userId: target.id, role, grantedBy: actorId, grantedAt: Date.now() })
      this.writeAudit({
        workspaceId: doc.workspaceId,
        docId,
        actorId,
        action: 'member.grant',
        targetType: 'member',
        targetId: target.id,
        detail: `添加成员 ${target.displayName}，角色：${role}`,
      })
    }
    this.save()
    this.onPermissionChange?.({ docId, workspaceId: doc.workspaceId, userId: target.id, role })
    return {
      userId: target.id,
      user: this.publicUser(target),
      role,
      grantedBy: actorId,
      grantedAt: Date.now(),
    }
  }

  /** 移除文档成员（其在线连接将被强制退出文档） */
  revokeDocMember(actorId: string, docId: string, targetUserId: string) {
    const doc = this.requireDocAdmin(docId, actorId)
    const map = this.docMembers.get(docId)
    if (!map?.has(targetUserId)) throw new ApiError(404, 'NOT_FOUND', '该成员未被授权')
    if (targetUserId === actorId) throw new ApiError(400, 'BAD_REQUEST', '不能移除自己，请转交管理权后退出')
    const name = this.requireUser(targetUserId).displayName
    map.delete(targetUserId)
    this.writeAudit({
      workspaceId: doc.workspaceId,
      docId,
      actorId,
      action: 'member.remove',
      targetType: 'member',
      targetId: targetUserId,
      detail: `移除文档成员 ${name}`,
    })
    this.save()
    this.onPermissionChange?.({ docId, workspaceId: doc.workspaceId, userId: targetUserId, role: null })
  }

  /* ---------------- 最近协作 / 审计 ---------------- */

  touchRecent(userId: string, docId: string) {
    const doc = this.docs.get(docId)
    if (!doc) return
    let list = this.recent.get(userId)
    if (!list) {
      list = []
      this.recent.set(userId, list)
    }
    const i = list.findIndex((r) => r.docId === docId)
    const entry: RecentDoc = { docId, workspaceId: doc.workspaceId, title: doc.title, lastOpenedAt: Date.now() }
    if (i >= 0) list.splice(i, 1)
    list.unshift(entry)
    if (list.length > RECENT_LIMIT) list.length = RECENT_LIMIT
    this.save()
  }

  listRecent(userId: string): RecentDoc[] {
    // 仅保留当前仍有权限的文档
    return (this.recent.get(userId) || []).filter((r) => this.resolveDocRole(r.docId, userId) !== null)
  }

  private writeAudit(e: Omit<AuditEntry, 'id' | 'actorName' | 'at'>) {
    const actor = this.users.get(e.actorId)
    this.audit.unshift({
      ...e,
      id: `aud-${randomUUID()}`,
      actorName: actor?.displayName || e.actorId,
      at: Date.now(),
    })
    if (this.audit.length > AUDIT_LIMIT) this.audit.length = AUDIT_LIMIT
  }

  /** 审计日志：工作区管理员可看全工作区；文档管理员可看本文档相关 */
  listAudit(actorId: string, workspaceId: string, docId?: string, limit = 100): AuditEntry[] {
    if (docId) {
      if (this.resolveDocRole(docId, actorId) !== 'admin') {
        throw new ApiError(403, 'PERMISSION_DENIED', '仅文档管理员可查看审计记录')
      }
    } else {
      this.requireWorkspaceAdmin(workspaceId, actorId)
    }
    return this.audit
      .filter((a) => a.workspaceId === workspaceId && (!docId || a.docId === docId))
      .slice(0, limit)
  }
}
