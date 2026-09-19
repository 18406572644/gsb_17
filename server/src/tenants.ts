/**
 * 多租户存储层：账号、会话令牌、工作区与成员、文档元数据、文档级权限、
 * 权限变更审计、最近访问。
 *
 * 单进程 JSON 文件持久化（与现有文档内容持久化同一轻量化定位），
 * 所有变更经防抖写盘；关键鉴权判定集中在本文件，REST 与 WS 共用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import type { AuditEntry, DocMeta, WorkspaceRole } from '../../shared/api'
import type { Role } from '../../shared/protocol'
import { ApiError } from './errors'

/* ---------------- 持久化记录 ---------------- */

interface AccountRecord {
  id: string
  username: string
  name: string
  salt: string
  hash: string
  color: string
  createdAt: number
}

interface SessionRecord {
  token: string
  userId: string
  createdAt: number
}

interface WorkspaceRecord {
  id: string
  name: string
  ownerId: string
  createdAt: number
}

interface MembershipRecord {
  workspaceId: string
  userId: string
  role: WorkspaceRole
}

interface DocRecord {
  id: string
  workspaceId: string
  title: string
  createdBy: string
  createdAt: number
  updatedAt: number
}

interface DocPermissionRecord {
  docId: string
  userId: string
  role: Role
}

interface AuditRecord extends AuditEntry {}

interface RecentRecord {
  userId: string
  workspaceId: string
  docId: string
  lastVisitedAt: number
}

interface TenantData {
  accounts: AccountRecord[]
  workspaces: WorkspaceRecord[]
  memberships: MembershipRecord[]
  docs: DocRecord[]
  docPermissions: DocPermissionRecord[]
  audit: AuditRecord[]
  recents: RecentRecord[]
}

interface SessionInfo {
  token: string
  userId: string
}

const COLORS = [
  '#409eff',
  '#67c23a',
  '#e6a23c',
  '#f56c6c',
  '#9b59b6',
  '#16a085',
  '#d35400',
  '#2c3e50',
]

const AUDIT_LIMIT = 2000
const RECENT_LIMIT = 12

/** 工作区管理员对其工作区内任意文档的隐式有效角色 */
const ADMIN_DOC_ROLE: Role = 'manager'

export class TenantStore {
  private data: TenantData = {
    accounts: [],
    workspaces: [],
    memberships: [],
    docs: [],
    docPermissions: [],
    audit: [],
    recents: [],
  }
  private sessions = new Map<string, SessionRecord>()
  private persistTimer: NodeJS.Timeout | null = null
  /** 首次播种的文档内容（仅全新初始化时存在，供 index.ts 初始化文档会话） */
  seedContent = new Map<string, { workspaceId: string; content: string }>()

  constructor(private file: string) {}

  /* ---------------- 启动 / 持久化 ---------------- */

  bootstrap() {
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf8'))
        console.log(`[tenant] 已加载租户数据：${this.data.accounts.length} 账号 / ${this.data.workspaces.length} 工作区`)
        return
      } catch (e) {
        console.error('[tenant] 租户数据损坏，重新播种:', e)
      }
    }
    this.seed()
    this.flush()
  }

  private schedulePersist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flush()
    }, 400)
  }

  flush() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  shutdown() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.flush()
  }

  /* ---------------- 认证 ---------------- */

  private hashPassword(password: string, saltHex?: string) {
    const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(16)
    const hash = scryptSync(password, salt, 64)
    return { salt: salt.toString('hex'), hash: hash.toString('hex') }
  }

  register(username: string, password: string, name: string) {
    username = username.trim().toLowerCase()
    name = name.trim()
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      throw ApiError.bad('登录名需为 3-20 位小写字母、数字或下划线')
    }
    if (password.length < 6) throw ApiError.bad('密码至少 6 位')
    if (!name) throw ApiError.bad('昵称不能为空')
    if (this.data.accounts.some((a) => a.username === username)) {
      throw ApiError.conflict('该登录名已被注册')
    }
    const acc: AccountRecord = {
      id: randomUUID(),
      username,
      name: name.slice(0, 24),
      ...this.hashPassword(password),
      color: COLORS[this.data.accounts.length % COLORS.length],
      createdAt: Date.now(),
    }
    this.data.accounts.push(acc)
    // 每个新账号自动拥有一个个人工作区
    this.createWorkspaceRecord(acc.id, `${acc.name} 的工作区`)
    this.schedulePersist()
    return this.issueSession(acc.id)
  }

  login(username: string, password: string): SessionInfo {
    username = username.trim().toLowerCase()
    const acc = this.data.accounts.find((a) => a.username === username)
    if (!acc || acc.hash !== this.hashPassword(password, acc.salt).hash) {
      throw ApiError.unauthorized('登录名或密码不正确')
    }
    return this.issueSession(acc.id)
  }

  private issueSession(userId: string): SessionInfo {
    // 同一账号旧令牌保留（多标签 / 多设备可同时在线），新令牌额外签发
    const token = randomBytes(24).toString('hex')
    const rec = { token, userId, createdAt: Date.now() }
    this.sessions.set(token, rec)
    return { token, userId }
  }

  logout(token: string) {
    this.sessions.delete(token)
  }

  /** 按令牌解析账号，失败抛 401 */
  requireUser(token: string): AccountRecord {
    const rec = this.sessions.get(token)
    if (!rec) throw ApiError.unauthorized()
    const acc = this.data.accounts.find((a) => a.id === rec.userId)
    if (!acc) throw ApiError.unauthorized()
    return acc
  }

  getAccount(userId: string): AccountRecord | undefined {
    return this.data.accounts.find((a) => a.id === userId)
  }

  requireAccount(userId: string): AccountRecord {
    const acc = this.getAccount(userId)
    if (!acc) throw ApiError.notFound('用户不存在')
    return acc
  }

  toAccount(acc: AccountRecord) {
    return { id: acc.id, name: acc.name, username: acc.username, color: acc.color }
  }

  /* ---------------- 工作区与成员 ---------------- */

  private createWorkspaceRecord(ownerId: string, name: string): WorkspaceRecord {
    const ws: WorkspaceRecord = {
      id: randomUUID(),
      name: name.slice(0, 60),
      ownerId,
      createdAt: Date.now(),
    }
    this.data.workspaces.push(ws)
    this.data.memberships.push({ workspaceId: ws.id, userId: ownerId, role: 'admin' })
    return ws
  }

  createWorkspace(actorId: string, name: string): WorkspaceRecord {
    name = name.trim()
    if (!name) throw ApiError.bad('工作区名称不能为空')
    const ws = this.createWorkspaceRecord(actorId, name)
    this.schedulePersist()
    return ws
  }

  listWorkspacesFor(userId: string): WorkspaceRecord[] {
    const ids = new Set(
      this.data.memberships.filter((m) => m.userId === userId).map((m) => m.workspaceId),
    )
    return this.data.workspaces.filter((w) => ids.has(w.id))
  }

  getWorkspace(workspaceId: string): WorkspaceRecord {
    const ws = this.data.workspaces.find((w) => w.id === workspaceId)
    if (!ws) throw ApiError.notFound('工作区不存在')
    return ws
  }

  membership(workspaceId: string, userId: string): MembershipRecord | undefined {
    return this.data.memberships.find((m) => m.workspaceId === workspaceId && m.userId === userId)
  }

  /** 必须是工作区成员，否则 403/404 */
  requireMember(workspaceId: string, userId: string): MembershipRecord {
    this.getWorkspace(workspaceId)
    const m = this.membership(workspaceId, userId)
    if (!m) throw ApiError.forbidden('你不是该工作区成员')
    return m
  }

  requireWorkspaceAdmin(workspaceId: string, userId: string): MembershipRecord {
    const m = this.requireMember(workspaceId, userId)
    if (m.role !== 'admin') throw ApiError.forbidden('仅工作区管理员可执行该操作')
    return m
  }

  listMembers(workspaceId: string) {
    const memberIds = new Set(
      this.data.memberships.filter((m) => m.workspaceId === workspaceId).map((m) => m.userId),
    )
    return this.data.accounts
      .filter((a) => memberIds.has(a.id))
      .map((a) => ({
        membership: this.membership(workspaceId, a.id)!,
        account: a,
      }))
  }

  addMember(actorId: string, workspaceId: string, username: string, role: WorkspaceRole) {
    this.requireWorkspaceAdmin(workspaceId, actorId)
    if (role !== 'admin' && role !== 'member') throw ApiError.bad('角色不合法')
    const acc = this.data.accounts.find((a) => a.username === username.trim().toLowerCase())
    if (!acc) throw ApiError.notFound('该登录名对应的用户不存在')
    if (this.membership(workspaceId, acc.id)) throw ApiError.conflict('该用户已是工作区成员')
    this.data.memberships.push({ workspaceId, userId: acc.id, role })
    this.addAudit({
      workspaceId,
      kind: 'workspace-role',
      targetUserId: acc.id,
      targetUserName: acc.name,
      fromRole: null,
      toRole: role,
      operatorId: actorId,
      operatorName: this.requireAccount(actorId).name,
    })
    this.schedulePersist()
  }

  updateMemberRole(actorId: string, workspaceId: string, targetUserId: string, role: WorkspaceRole) {
    this.requireWorkspaceAdmin(workspaceId, actorId)
    if (role !== 'admin' && role !== 'member') throw ApiError.bad('角色不合法')
    const m = this.membership(workspaceId, targetUserId)
    if (!m) throw ApiError.notFound('成员不存在')
    const ws = this.getWorkspace(workspaceId)
    if (targetUserId === ws.ownerId) throw ApiError.conflict('工作区创建者的管理员身份不可变更')
    if (m.role === role) return { changes: [] }
    const from = m.role
    m.role = role
    this.addAudit({
      workspaceId,
      kind: 'workspace-role',
      targetUserId,
      targetUserName: this.requireAccount(targetUserId).name,
      fromRole: from,
      toRole: role,
      operatorId: actorId,
      operatorName: this.requireAccount(actorId).name,
    })
    this.schedulePersist()
    // 工作区角色变化会改变各文档的隐式有效角色（admin↔manager），计算需实时推送的变化
    const changes: { docId: string; fromRole: Role | null; toRole: Role | null }[] = []
    for (const doc of this.data.docs.filter((d) => d.workspaceId === workspaceId)) {
      const before = this.docRoleUnderWorkspaceRole(workspaceId, doc.id, targetUserId, from)
      const to = this.effectiveDocRole(workspaceId, doc.id, targetUserId)
      if (before !== to) changes.push({ docId: doc.id, fromRole: before, toRole: to })
    }
    return { changes }
  }

  /** 按「给定工作区角色」推导文档有效角色（用于变更前后对比） */
  private docRoleUnderWorkspaceRole(
    workspaceId: string,
    docId: string,
    userId: string,
    wsRole: WorkspaceRole,
  ): Role | null {
    if (!this.membership(workspaceId, userId)) return null
    if (wsRole === 'admin') return 'manager'
    const p = this.data.docPermissions.find((d) => d.docId === docId && d.userId === userId)
    return p ? p.role : null
  }

  removeMember(actorId: string, workspaceId: string, targetUserId: string) {
    this.requireWorkspaceAdmin(workspaceId, actorId)
    const ws = this.getWorkspace(workspaceId)
    if (targetUserId === ws.ownerId) throw ApiError.conflict('工作区创建者不可被移除')
    const m = this.membership(workspaceId, targetUserId)
    if (!m) throw ApiError.notFound('成员不存在')
    const targetName = this.requireAccount(targetUserId).name
    // 级联收回该用户在本工作区全部文档上的显式授权
    const docIds = this.data.docs.filter((d) => d.workspaceId === workspaceId).map((d) => d.id)
    this.data.docPermissions = this.data.docPermissions.filter(
      (p) => !(docIds.includes(p.docId) && p.userId === targetUserId),
    )
    this.data.memberships = this.data.memberships.filter((x) => x !== m)
    this.addAudit({
      workspaceId,
      kind: 'workspace-role',
      targetUserId,
      targetUserName: targetName,
      fromRole: m.role,
      toRole: null,
      operatorId: actorId,
      operatorName: this.requireAccount(actorId).name,
    })
    this.schedulePersist()
    // 返回被影响文档，供 Hub 实时踢下线 / 收回权限
    return docIds
  }

  /* ---------------- 文档 ---------------- */

  createDoc(actorId: string, workspaceId: string, title: string): DocRecord {
    this.requireMember(workspaceId, actorId)
    title = title.trim()
    if (!title) throw ApiError.bad('文档标题不能为空')
    const doc: DocRecord = {
      id: randomUUID(),
      workspaceId,
      title: title.slice(0, 80),
      createdBy: actorId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.data.docs.push(doc)
    // 创建者获得显式管理权限（普通成员创建的文档默认仅自己可见，需主动授权协作）
    this.data.docPermissions.push({ docId: doc.id, userId: actorId, role: 'manager' })
    this.schedulePersist()
    return doc
  }

  getDoc(workspaceId: string, docId: string): DocRecord {
    const doc = this.data.docs.find((d) => d.id === docId && d.workspaceId === workspaceId)
    if (!doc) throw ApiError.notFound('文档不存在')
    return doc
  }

  /**
   * 计算用户对文档的有效角色：
   * 工作区 admin 隐式为 manager；否则取文档级显式授权；都没有则 null（无权限）。
   */
  effectiveDocRole(workspaceId: string, docId: string, userId: string): Role | null {
    const m = this.membership(workspaceId, userId)
    if (!m) return null
    if (m.role === 'admin') return ADMIN_DOC_ROLE
    const p = this.data.docPermissions.find((d) => d.docId === docId && d.userId === userId)
    return p ? p.role : null
  }

  /** 鉴权进入文档：成员 + 有效角色非空，返回文档与角色 */
  requireDocAccess(actorId: string, workspaceId: string, docId: string): {
    doc: DocRecord
    role: Role
  } {
    this.requireMember(workspaceId, actorId)
    const doc = this.getDoc(workspaceId, docId)
    const role = this.effectiveDocRole(workspaceId, docId, actorId)
    if (!role) throw ApiError.forbidden('你没有该文档的访问权限')
    return { doc, role }
  }

  /** 当前用户在工作区中有权限看到的文档目录 */
  listAccessibleDocs(userId: string, workspaceId: string): DocRecord[] {
    this.requireMember(workspaceId, userId)
    return this.data.docs
      .filter((d) => d.workspaceId === workspaceId && this.effectiveDocRole(workspaceId, d.id, userId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  markDocActivity(workspaceId: string, docId: string) {
    const doc = this.data.docs.find((d) => d.id === docId && d.workspaceId === workspaceId)
    if (doc) {
      doc.updatedAt = Date.now()
      this.schedulePersist()
    }
  }

  touchRecent(userId: string, workspaceId: string, docId: string) {
    const existing = this.data.recents.find(
      (r) => r.userId === userId && r.workspaceId === workspaceId && r.docId === docId,
    )
    if (existing) {
      existing.lastVisitedAt = Date.now()
    } else {
      this.data.recents.push({ userId, workspaceId, docId, lastVisitedAt: Date.now() })
    }
    this.schedulePersist()
  }

  listRecent(userId: string) {
    return this.data.recents
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, RECENT_LIMIT)
      .map((r) => {
        const doc = this.data.docs.find((d) => d.id === r.docId && d.workspaceId === r.workspaceId)
        if (!doc || this.data.workspaces.every((w) => w.id !== r.workspaceId)) return null
        const role = this.effectiveDocRole(r.workspaceId, r.docId, userId)
        if (!role) return null
        return { rec: r, doc, role }
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
  }

  /* ---------------- 文档权限配置 + 审计 ---------------- */

  /** 列出文档有效权限（manager 可查看） */
  listDocPermissions(actorId: string, workspaceId: string, docId: string) {
    const role = this.effectiveDocRole(workspaceId, docId, actorId)
    if (role !== 'manager') throw ApiError.forbidden('仅文档管理者可配置权限')
    this.getDoc(workspaceId, docId)
    return this.buildPermissionList(workspaceId, docId)
  }

  private buildPermissionList(workspaceId: string, docId: string) {
    return this.listMembers(workspaceId).map(({ membership: m, account: a }) => {
      const explicit = this.data.docPermissions.find(
        (p) => p.docId === docId && p.userId === a.id,
      )
      const implicit = m.role === 'admin'
      return {
        userId: a.id,
        name: a.name,
        username: a.username,
        color: a.color,
        role: (implicit ? ADMIN_DOC_ROLE : explicit?.role ?? null) as Role | null,
        implicit,
        explicitRole: explicit?.role ?? null,
        workspaceRole: m.role,
      }
    })
  }

  /**
   * 配置文档权限。返回审计/推送所需的变更信息。
   * role=null 表示移除显式授权（工作区 admin 仍隐式为 manager）。
   */
  setDocPermission(
    actorId: string,
    workspaceId: string,
    docId: string,
    targetUserId: string,
    role: Role | null,
  ): { targetUserId: string; fromRole: Role | null; toRole: Role | null } {
    const actorRole = this.effectiveDocRole(workspaceId, docId, actorId)
    if (actorRole !== 'manager') throw ApiError.forbidden('仅文档管理者可配置权限')
    const doc = this.getDoc(workspaceId, docId)
    const target = this.membership(workspaceId, targetUserId)
    if (!target) throw ApiError.notFound('目标用户不是该工作区成员')
    if (!role) role = null
    const valid: Role[] = ['viewer', 'commenter', 'editor', 'manager']
    if (role !== null && !valid.includes(role)) throw ApiError.bad('权限角色不合法')

    const targetAcc = this.requireAccount(targetUserId)
    const fromRole = this.effectiveDocRole(workspaceId, docId, targetUserId)
    const existing = this.data.docPermissions.find(
      (p) => p.docId === docId && p.userId === targetUserId,
    )

    if (target.role === 'admin') {
      // admin 恒为隐式 manager：显式授权无实际意义，禁止制造困惑
      if (existing) {
        this.data.docPermissions = this.data.docPermissions.filter((p) => p !== existing)
      }
    } else if (role === null) {
      if (existing) this.data.docPermissions = this.data.docPermissions.filter((p) => p !== existing)
    } else if (existing) {
      existing.role = role
    } else {
      this.data.docPermissions.push({ docId, userId: targetUserId, role })
    }

    const toRole = this.effectiveDocRole(workspaceId, docId, targetUserId)
    // 仅在有效权限真正变化时记审计（避免无意义配置刷审计）
    if (fromRole !== toRole) {
      this.addAudit({
        workspaceId,
        kind: 'doc-permission',
        docId,
        docTitle: doc.title,
        targetUserId,
        targetUserName: targetAcc.name,
        fromRole,
        toRole,
        operatorId: actorId,
        operatorName: this.requireAccount(actorId).name,
      })
    }
    this.schedulePersist()
    return { targetUserId, fromRole, toRole }
  }

  listDocAudit(actorId: string, workspaceId: string, docId: string): AuditEntry[] {
    const role = this.effectiveDocRole(workspaceId, docId, actorId)
    if (role !== 'manager') throw ApiError.forbidden('仅文档管理者可查看审计')
    this.getDoc(workspaceId, docId)
    return this.data.audit
      .filter((a) => a.workspaceId === workspaceId && a.docId === docId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  private addAudit(
    entry: Omit<AuditEntry, 'id' | 'createdAt'> & { createdAt?: number },
  ) {
    this.data.audit.push({
      id: randomUUID(),
      createdAt: Date.now(),
      ...entry,
    } as AuditEntry)
    if (this.data.audit.length > AUDIT_LIMIT) {
      this.data.audit.splice(0, this.data.audit.length - AUDIT_LIMIT)
    }
  }

  /* ---------------- 视图组装（供 REST） ---------------- */

  toWorkspaceView(ws: WorkspaceRecord, userId: string) {
    const memberIds = this.data.memberships.filter((m) => m.workspaceId === ws.id)
    return {
      id: ws.id,
      name: ws.name,
      myRole: this.membership(ws.id, userId)!.role,
      memberCount: memberIds.length,
      docCount: this.data.docs.filter((d) => d.workspaceId === ws.id).length,
      createdAt: ws.createdAt,
    }
  }

  toDocMeta(doc: DocRecord, role: Role): DocMeta {
    return {
      id: doc.id,
      workspaceId: doc.workspaceId,
      title: doc.title,
      updatedAt: doc.updatedAt,
      createdAt: doc.createdAt,
      myRole: role,
    }
  }

  /** 文档权限配置对话框数据 */
  docPermissionView(actorId: string, workspaceId: string, docId: string) {
    const doc = this.getDoc(workspaceId, docId)
    const role = this.effectiveDocRole(workspaceId, docId, actorId)
    if (role !== 'manager') throw ApiError.forbidden('仅文档管理者可配置权限')
    const permissions = this.buildPermissionList(workspaceId, docId)
      .filter((p) => p.role !== null)
      .map((p) => ({
        userId: p.userId,
        name: p.name,
        username: p.username,
        color: p.color,
        role: p.role as Role,
        implicit: p.implicit,
      }))
    const audit = this.data.audit
      .filter((a) => a.workspaceId === workspaceId && a.docId === docId)
      .sort((a, b) => b.createdAt - a.createdAt)
    return { doc: this.toDocMeta(doc, role), permissions, audit }
  }

  /* ---------------- 演示种子 ---------------- */

  private seed() {
    const mk = (username: string, name: string, password: string, color: string): AccountRecord => {
      const acc: AccountRecord = {
        id: randomUUID(),
        username,
        name,
        ...this.hashPassword(password),
        color,
        createdAt: Date.now(),
      }
      this.data.accounts.push(acc)
      return acc
    }

    const alice = mk('alice', '林安', 'demo1234', '#f56c6c')
    const bob = mk('bob', '王博文', 'demo1234', '#409eff')
    const carol = mk('carol', '陈晓艺', 'demo1234', '#67c23a')
    const dave = mk('dave', '戴伟', 'demo1234', '#e6a23c')

    const PRD_CONTENT = `# 产品需求文档（PRD）

本文档演示企业级多文档协作与细粒度权限：

1. 林安（alice）是工作区管理员，对所有文档拥有「管理」权限；
2. 王博文（bob）在本文档为「编辑」，可直接修改正文；
3. 陈晓艺（carol）在本文档为「批注」，只能选中文字添加批注；
4. 戴伟（dave）在本文档为「查看」，只读旁观。

用不同账号登录后进入同一文档，可体验多人实时协同；
管理员在右上角「成员权限」中在线调整角色，被降权用户的在途操作会被立即拦截。
`

    const MEETING_CONTENT = `# 迭代会议纪要

- 本周目标：完成工作区与权限体系联调
- 风险：跨标签会话的权限实时推送时序
- 行动项：补充降权拦截的端到端测试
`

    const PLAN_CONTENT = `# 季度规划

Q4 聚焦企业协作场景：多租户、审计、权限实时生效。
`

    const DESIGN_CONTENT = `# 设计规范

- 主色板与语义色
- 批注高亮的对比度要求
- 降权提示的交互规范
`

    // 工作区 1：产品研发部（alice 管理员）
    const rd = this.createWorkspaceRecord(alice.id, '产品研发部')
    for (const [u, role] of [
      [bob, 'member'],
      [carol, 'member'],
      [dave, 'member'],
    ] as const) {
      this.data.memberships.push({ workspaceId: rd.id, userId: u.id, role })
    }

    const mkDoc = (wsId: string, title: string, creator: string, content: string): DocRecord => {
      const doc: DocRecord = {
        id: randomUUID(),
        workspaceId: wsId,
        title,
        createdBy: creator,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      this.data.docs.push(doc)
      this.seedContent.set(doc.id, { workspaceId: wsId, content })
      return doc
    }

    const grant = (doc: DocRecord, user: AccountRecord, role: Role) => {
      this.data.docPermissions.push({ docId: doc.id, userId: user.id, role })
    }

    const prd = mkDoc(rd.id, '产品需求文档 PRD', alice.id, PRD_CONTENT)
    grant(prd, bob, 'editor')
    grant(prd, carol, 'commenter')
    grant(prd, dave, 'viewer')

    const meeting = mkDoc(rd.id, '迭代会议纪要', alice.id, MEETING_CONTENT)
    grant(meeting, bob, 'editor')
    grant(meeting, carol, 'viewer')

    const plan = mkDoc(rd.id, '季度规划', alice.id, PLAN_CONTENT)
    grant(plan, bob, 'commenter')

    // 工作区 2：设计组（carol 管理员）
    const design = this.createWorkspaceRecord(carol.id, '设计组')
    this.data.memberships.push({ workspaceId: design.id, userId: dave.id, role: 'member' })
    const spec = mkDoc(design.id, '设计规范', carol.id, DESIGN_CONTENT)
    grant(spec, dave, 'editor')

    console.log('[tenant] 已播种演示数据：alice / bob / carol / dave，密码均为 demo1234')
  }
}
