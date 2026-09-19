import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AuditEntry,
  DocListItem,
  DocMemberView,
  DocPermission,
  RecentDoc,
  Workspace,
  WorkspaceDoc,
  WorkspaceListItem,
  WorkspaceMemberView,
  WorkspaceRole,
} from '../../../shared/tenant'
import { api } from '@/api/http'

/** 工作台数据：工作区列表、当前工作区文档目录、最近协作、文档成员与审计 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref<WorkspaceListItem[]>([])
  const currentWorkspaceId = ref<string>('')
  const docs = ref<DocListItem[]>([])
  const recent = ref<RecentDoc[]>([])
  const workspaceMembers = ref<WorkspaceMemberView[]>([])

  /** 当前打开文档的详情（含权限与成员） */
  const currentDoc = ref<WorkspaceDoc | null>(null)
  const permission = ref<DocPermission | null>(null)
  const docMembers = ref<DocMemberView[]>([])
  const docAudit = ref<AuditEntry[]>([])
  const workspaceAudit = ref<AuditEntry[]>([])

  const loading = ref(false)
  const currentWorkspace = computed<Workspace | null>(
    () => workspaces.value.find((w) => w.workspace.id === currentWorkspaceId.value)?.workspace || null,
  )
  const currentWorkspaceRole = computed<WorkspaceRole | null>(
    () => workspaces.value.find((w) => w.workspace.id === currentWorkspaceId.value)?.role || null,
  )

  async function loadWorkspaces() {
    const [wRes, rRes] = await Promise.all([api.listWorkspaces(), api.recent()])
    workspaces.value = wRes.workspaces
    recent.value = rRes.recent
    if (!currentWorkspaceId.value && workspaces.value[0]) {
      currentWorkspaceId.value = workspaces.value[0].workspace.id
    }
    if (currentWorkspaceId.value) await loadDocs(currentWorkspaceId.value)
  }

  async function selectWorkspace(wsId: string) {
    currentWorkspaceId.value = wsId
    await loadDocs(wsId)
  }

  async function loadDocs(wsId?: string) {
    const id = wsId || currentWorkspaceId.value
    if (!id) return
    loading.value = true
    try {
      const [dRes, wRes] = await Promise.all([api.listDocs(id), api.workspaceDetail(id)])
      docs.value = dRes.docs
      workspaceMembers.value = wRes.members
    } finally {
      loading.value = false
    }
  }

  async function refreshRecent() {
    recent.value = (await api.recent()).recent
  }

  async function createWorkspace(name: string, description: string) {
    const res = await api.createWorkspace({ name, description })
    await loadWorkspaces()
    currentWorkspaceId.value = res.workspace.id
    await loadDocs(res.workspace.id)
    return res.workspace
  }

  async function addWorkspaceMember(username: string, role: WorkspaceRole) {
    await api.addWorkspaceMember(currentWorkspaceId.value, { username, role })
    await loadDocs(currentWorkspaceId.value)
  }

  async function changeWorkspaceMember(userId: string, role: WorkspaceRole) {
    await api.updateWorkspaceMember(currentWorkspaceId.value, userId, role)
    await loadDocs(currentWorkspaceId.value)
  }

  async function removeWorkspaceMember(userId: string) {
    await api.removeWorkspaceMember(currentWorkspaceId.value, userId)
    await loadDocs(currentWorkspaceId.value)
  }

  async function createDoc(title: string) {
    return (await api.createDoc(currentWorkspaceId.value, { title })).doc
  }

  /** 进入编辑器前加载文档详情、有效权限与成员（权限加载门禁） */
  async function openDoc(docId: string) {
    const res = await api.docDetail(docId)
    currentDoc.value = res.doc
    currentWorkspaceId.value = res.workspace.id
    permission.value = res.permission
    docMembers.value = res.members
    await api.markOpened(docId)
    return res
  }

  async function refreshDocMembers() {
    if (!currentDoc.value) return
    docMembers.value = (await api.listDocMembers(currentDoc.value.id)).members
  }

  async function refreshDocAudit() {
    if (!currentDoc.value) return
    docAudit.value = (await api.docAudit(currentDoc.value.id)).entries
  }

  async function refreshWorkspaceAudit() {
    if (!currentWorkspaceId.value) return
    workspaceAudit.value = (await api.workspaceAudit(currentWorkspaceId.value)).entries
  }

  async function grantMember(username: string, role: DocMemberView['role']) {
    if (!currentDoc.value) return
    await api.grantDocMember(currentDoc.value.id, { username, role })
    await refreshDocMembers()
  }

  async function revokeMember(userId: string) {
    if (!currentDoc.value) return
    await api.revokeDocMember(currentDoc.value.id, userId)
    await refreshDocMembers()
  }

  async function renameDoc(title: string) {
    if (!currentDoc.value) return
    currentDoc.value = (await api.renameDoc(currentDoc.value.id, { title })).doc
  }

  async function deleteDoc(docId: string) {
    await api.deleteDoc(docId)
    if (currentDoc.value?.id === docId) currentDoc.value = null
  }

  function clearCurrentDoc() {
    currentDoc.value = null
    permission.value = null
    docMembers.value = []
    docAudit.value = []
  }

  return {
    workspaces,
    currentWorkspaceId,
    docs,
    recent,
    workspaceMembers,
    currentDoc,
    permission,
    docMembers,
    docAudit,
    workspaceAudit,
    loading,
    currentWorkspace,
    currentWorkspaceRole,
    loadWorkspaces,
    selectWorkspace,
    loadDocs,
    refreshRecent,
    createWorkspace,
    addWorkspaceMember,
    changeWorkspaceMember,
    removeWorkspaceMember,
    createDoc,
    openDoc,
    refreshDocMembers,
    refreshDocAudit,
    refreshWorkspaceAudit,
    grantMember,
    revokeMember,
    renameDoc,
    deleteDoc,
    clearCurrentDoc,
  }
})
