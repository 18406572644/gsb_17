<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useSessionStore } from '@/stores/session'
import LoginGate from '@/components/LoginGate.vue'
import WorkspaceView from '@/components/WorkspaceView.vue'
import TopBar from '@/components/TopBar.vue'
import EditorView from '@/components/EditorView.vue'
import AnnotationPanel from '@/components/AnnotationPanel.vue'

const auth = useAuthStore()
const session = useSessionStore()

onMounted(() => auth.bootstrap())
</script>

<template>
  <div v-if="!auth.bootstrapped" v-loading="true" class="app-boot" element-loading-text="正在恢复登录态…" />
  <LoginGate v-else-if="!auth.isLoggedIn" />
  <WorkspaceView v-else-if="!session.joined" />
  <div v-else class="app-shell">
    <TopBar />
    <el-alert
      v-if="session.status === 'offline'"
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
