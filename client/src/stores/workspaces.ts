import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/api'
import type {
  Account,
  DocMeta,
  RecentDoc,
  Workspace,
  WorkspaceDetail,
} from '../../../shared/api'

/** 工作区/文档目录数据：首页聚合 + 当前工作区详情 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const account = ref<Account | null>(null)
  const workspaces = ref<Workspace[]>([])
  const recent = ref<RecentDoc[]>([])
  const current = ref<WorkspaceDetail | null>(null)
  const loading = ref(false)

  async function loadHome() {
    loading.value = true
    try {
      const data = await api.home()
      account.value = data.account
      workspaces.value = data.workspaces
      recent.value = data.recent
    } finally {
      loading.value = false
    }
  }

  async function openWorkspace(wid: string) {
    loading.value = true
    try {
      current.value = await api.workspace(wid)
    } finally {
      loading.value = false
    }
  }

  function closeWorkspace() {
    current.value = null
  }

  async function refreshCurrent() {
    if (current.value) await openWorkspace(current.value.workspace.id)
  }

  async function createWorkspace(name: string) {
    const ws = await api.createWorkspace({ name })
    await loadHome()
    return ws
  }

  async function createDoc(title: string): Promise<DocMeta> {
    if (!current.value) throw new Error('未选择工作区')
    const doc = await api.createDoc(current.value.workspace.id, { title })
    await refreshCurrent()
    await loadHome()
    return doc
  }

  function $reset() {
    account.value = null
    workspaces.value = []
    recent.value = []
    current.value = null
  }

  return {
    account,
    workspaces,
    recent,
    current,
    loading,
    loadHome,
    openWorkspace,
    closeWorkspace,
    refreshCurrent,
    createWorkspace,
    createDoc,
    $reset,
  }
})
