<script setup lang="ts">
import { onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { useSessionStore } from '@/stores/session'
import { useWorkspaceStore } from '@/stores/workspaces'
import { collab } from '@/collab/collab'
import AuthGate from '@/components/AuthGate.vue'
import WorkspaceHome from '@/components/WorkspaceHome.vue'
import TopBar from '@/components/TopBar.vue'
import EditorView from '@/components/EditorView.vue'
import AnnotationPanel from '@/components/AnnotationPanel.vue'

const auth = useAuthStore()
const session = useSessionStore()
const workspaces = useWorkspaceStore()

onMounted(() => {
  // 权限被服务端收回：离开编辑器并退回工作区首页，刷新可见文档目录
  collab.onAccessRevoked = async (message) => {
    collab.leave()
    ElMessage.error(message)
    try {
      await workspaces.loadHome()
    } catch {
      /* 忽略首页刷新冻结失败 */
    }
  }
})
</script>

<template>
  <div v-if="!auth.ready" class="boot-loading">
    <el-icon class="is-loading" :size="28"><Loading /></el-icon>
    <span>加载中…</span>
  </div>

  <AuthGate v-else-if="!auth.isLoggedIn" />

  <WorkspaceHome v-else-if="!session.joined" />

  <div v-else class="app-shell">
    <TopBar />
    <el-alert
      v-if="session.permissionNotice"
      type="warning"
      :closable="true"
      show-icon
      :title="session.permissionNotice"
      @close="session.permissionNotice = null"
    />
    <el-alert
      v-if="session.status === 'offline' && !session.accessRevoked"
      type="warning"
      :closable="false"
      show-icon
      title="当前处于离线状态：本地编辑与批注已暂存，重新连接后自动同步"
    />
    <el-alert
      v-else-if="session.status === 'reconnecting' || session.status === 'connecting'"
      type="info"
      :closable="false"
      show-icon
      :title="`连接已断开，正在重连（第 ${session.reconnectAttempt} 次）…`"
    />
    <div class="app-main">
      <div class="editor-pane">
        <EditorView />
      </div>
      <AnnotationPanel />
    </div>
  </div>
</template>

<style scoped>
.boot-loading {
  height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  color: #909399;
}
</style>
