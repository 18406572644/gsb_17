<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { useWorkspaceStore } from '@/stores/workspace'
import { collab } from '@/collab/collab'
import { ROLE_LABEL } from '../../../shared/protocol'
import UserAvatar from '@/components/UserAvatar.vue'
import DocMembersDialog from '@/components/DocMembersDialog.vue'
import AuditDialog from '@/components/AuditDialog.vue'
import type { DocListItem } from '../../../shared/tenant'

const session = useSessionStore()
const doc = useDocStore()
const workspace = useWorkspaceStore()

const membersVisible = ref(false)
const auditVisible = ref(false)

const connTag = computed(() => {
  switch (session.status) {
    case 'online':
      return { type: 'success' as const, text: '已连接' }
    case 'connecting':
      return { type: 'info' as const, text: '连接中…' }
    case 'reconnecting':
      return { type: 'warning' as const, text: `重连中(${session.reconnectAttempt})` }
    default:
      return { type: 'danger' as const, text: '已离线' }
  }
})

const syncTag = computed(() => {
  switch (doc.syncState) {
    case 'synced':
      return { type: 'success' as const, text: '已同步' }
    case 'pending':
      return { type: 'warning' as const, text: '同步中…' }
    default:
      return { type: 'info' as const, text: '重同步中…' }
  }
})

const roleTagType = computed(() => {
  if (session.role === 'admin') return 'danger'
  if (session.role === 'editor') return 'primary'
  if (session.role === 'commenter') return 'warning'
  return 'info'
})

const docListItem = computed<DocListItem | null>(() =>
  workspace.currentDoc
    ? { doc: workspace.currentDoc, role: session.role }
    : null,
)

function toggleOffline() {
  if (session.status === 'offline') {
    collab.reconnectNow()
  } else {
    collab.simulateDrop()
  }
}

async function backToWorkspace() {
  try {
    await ElMessageBox.confirm('确定返回工作台吗？', '退出文档', { type: 'info' })
  } catch {
    return
  }
  collab.leave()
  workspace.loadWorkspaces()
}
</script>

<template>
  <div class="topbar">
    <el-button size="small" plain @click="backToWorkspace">← 工作台</el-button>
    <span class="doc-title">📄 {{ session.docTitle || session.docId }}</span>
    <el-tag size="small" :type="connTag.type" effect="light">{{ connTag.text }}</el-tag>
    <el-tag size="small" :type="syncTag.type" effect="plain">{{ syncTag.text }}</el-tag>
    <el-tag size="small" :type="roleTagType" effect="dark">{{ ROLE_LABEL[session.role] }}</el-tag>
    <span style="font-size: 12px; color: #909399">v{{ doc.revision }}</span>

    <div class="spacer" />

    <div class="user-avatars">
      <el-tooltip
        v-for="u in session.users"
        :key="u.clientId"
        :content="`${u.name}（${ROLE_LABEL[u.role]}）${u.userId === session.userId ? ' - 我' : ''}`"
        placement="bottom"
      >
        <UserAvatar :user="u" />
      </el-tooltip>
    </div>

    <el-button v-if="session.canAdminDoc && docListItem" size="small" plain type="warning" @click="auditVisible = true">
      审计
    </el-button>
    <el-button v-if="session.canAdminDoc && docListItem" size="small" plain type="primary" @click="membersVisible = true">
      成员权限
    </el-button>
    <el-button
      size="small"
      :type="session.status === 'offline' ? 'success' : 'warning'"
      plain
      @click="toggleOffline"
    >
      {{ session.status === 'offline' ? '重新连接' : '模拟断线' }}
    </el-button>

    <DocMembersDialog v-if="membersVisible && docListItem" :doc-item="docListItem" @close="membersVisible = false" />
    <AuditDialog v-if="auditVisible" :doc-id="session.docId" :title="`文档审计 · ${session.docTitle}`" @close="auditVisible = false" />
  </div>
</template>
