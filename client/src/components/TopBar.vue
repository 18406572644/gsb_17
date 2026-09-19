<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useSessionStore } from '@/stores/session'
import { useDocStore } from '@/stores/doc'
import { collab } from '@/collab/collab'
import { ROLE_LABEL } from '../../../shared/protocol'
import UserAvatar from '@/components/UserAvatar.vue'
import PermissionDialog from '@/components/PermissionDialog.vue'
import type { DocMeta } from '../../../shared/api'

const session = useSessionStore()
const doc = useDocStore()
const permVisible = ref(false)

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
  switch (session.role) {
    case 'manager':
      return 'danger'
    case 'editor':
      return 'primary'
    case 'commenter':
      return 'warning'
    default:
      return 'info'
  }
})

const docMeta = computed<DocMeta>(() => ({
  id: session.docId,
  workspaceId: session.workspaceId,
  title: session.docTitle,
  updatedAt: 0,
  createdAt: 0,
  myRole: session.role,
}))

function toggleOffline() {
  if (session.status === 'offline') {
    collab.reconnectNow()
  } else {
    collab.simulateDrop()
  }
}

async function backHome() {
  try {
    await ElMessageBox.confirm('返回工作区首页？协同编辑将断开。', '返回', { type: 'info' })
  } catch {
    return
  }
  collab.leave()
}
</script>

<template>
  <div class="topbar">
    <el-button size="small" plain @click="backHome">← 工作区</el-button>
    <span class="doc-title">📄 {{ session.docTitle }}</span>
    <el-tag size="small" :type="connTag.type" effect="light">{{ connTag.text }}</el-tag>
    <el-tag size="small" :type="syncTag.type" effect="plain">{{ syncTag.text }}</el-tag>
    <el-tag size="small" :type="roleTagType" effect="dark">{{ ROLE_LABEL[session.role] }}</el-tag>
    <span style="font-size: 12px; color: #909399">v{{ doc.revision }}</span>

    <div class="spacer" />

    <el-button v-if="session.canManage" size="small" type="danger" plain @click="permVisible = true">
      成员权限
    </el-button>

    <div class="user-avatars">
      <el-tooltip
        v-for="u in session.users"
        :key="u.userId"
        :content="`${u.name}（${ROLE_LABEL[u.role]}）${u.userId === session.userId ? ' - 我' : ''}`"
        placement="bottom"
      >
        <UserAvatar :user="u" />
      </el-tooltip>
    </div>

    <el-button
      size="small"
      :type="session.status === 'offline' ? 'success' : 'warning'"
      plain
      @click="toggleOffline"
    >
      {{ session.status === 'offline' ? '重新连接' : '模拟断线' }}
    </el-button>

    <PermissionDialog v-if="permVisible" :doc="docMeta" @close="permVisible = false" />
  </div>
</template>

<style scoped>
.spacer {
  flex: 1;
}
</style>
