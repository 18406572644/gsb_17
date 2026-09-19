<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { useWorkspaceStore } from '@/stores/workspaces'
import { useSessionStore } from '@/stores/session'
import { api, ApiException } from '@/api'
import { collab } from '@/collab/collab'
import { ROLE_LABEL } from '../../../shared/protocol'
import type { DocMeta, Workspace } from '../../../shared/api'
import MembersDialog from '@/components/MembersDialog.vue'
import PermissionDialog from '@/components/PermissionDialog.vue'

const auth = useAuthStore()
const wsStore = useWorkspaceStore()
const session = useSessionStore()

const selectedWid = ref<string>('')
const creatingWs = ref(false)
const newWsName = ref('')
const creatingDoc = ref(false)
const newDocTitle = ref('')
const membersVisible = ref(false)
const permDoc = ref<DocMeta | null>(null)
const entering = ref<string>('')

onMounted(async () => {
  try {
    await wsStore.loadHome()
    if (wsStore.workspaces[0]) selectedWid.value = wsStore.workspaces[0].id
    if (selectedWid.value) await wsStore.openWorkspace(selectedWid.value)
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '加载工作台失败')
  }
})

const selectedWs = computed<Workspace | undefined>(() =>
  wsStore.workspaces.find((w) => w.id === selectedWid.value),
)
const isWsAdmin = computed(() => selectedWs.value?.myRole === 'admin')
const docs = computed(() => wsStore.current?.docs ?? [])
const members = computed(() => wsStore.current?.members ?? [])

async function selectWorkspace(wid: string) {
  selectedWid.value = wid
  await wsStore.openWorkspace(wid)
}

async function createWorkspace() {
  const name = newWsName.value.trim()
  if (!name) return
  try {
    const ws = await wsStore.createWorkspace(name)
    newWsName.value = ''
    creatingWs.value = false
    await selectWorkspace(ws.id)
    ElMessage.success('工作区已创建')
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '创建失败')
  }
}

async function createDoc() {
  const title = newDocTitle.value.trim()
  if (!title) return
  try {
    const doc = await wsStore.createDoc(title)
    newDocTitle.value = ''
    creatingDoc.value = false
    ElMessage.success('文档已创建')
    await openDoc(doc)
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '创建失败')
  }
}

/** 进入编辑器：先经 REST 预加载权限，再建立协同连接 */
async function openDoc(doc: DocMeta) {
  if (entering.value) return
  entering.value = doc.id
  try {
    const boot = await api.bootDoc(doc.workspaceId, doc.id)
    collab.enter({
      workspaceId: boot.workspaceId,
      docId: boot.doc.id,
      docTitle: boot.doc.title,
      role: boot.role,
    })
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '无法进入文档')
  } finally {
    entering.value = ''
  }
}

function roleTagType(role: string) {
  return role === 'manager' ? 'danger' : role === 'editor' ? 'primary' : role === 'commenter' ? 'warning' : 'info'
}

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function logout() {
  try {
    await ElMessageBox.confirm('确定退出登录吗？', '退出', { type: 'warning' })
  } catch {
    return
  }
  await auth.logout()
  wsStore.$reset()
  selectedWid.value = ''
}
</script>

<template>
  <div class="home-shell">
    <!-- 左侧工作区栏 -->
    <aside class="ws-sidebar">
      <div class="brand">📚 协同文档</div>
      <div class="ws-list">
        <div
          v-for="w in wsStore.workspaces"
          :key="w.id"
          class="ws-item"
          :class="{ active: w.id === selectedWid }"
          @click="selectWorkspace(w.id)"
        >
          <span class="ws-name">{{ w.name }}</span>
          <el-tag v-if="w.myRole === 'admin'" size="small" type="danger" effect="plain">管理员</el-tag>
        </div>
      </div>
      <el-button class="ws-add" text type="primary" @click="creatingWs = true">+ 新建工作区</el-button>

      <div class="ws-user">
        <span class="ws-avatar" :style="{ background: auth.account?.color }">
          {{ auth.account?.name.slice(0, 1) }}
        </span>
        <div class="ws-user-info">
          <div class="ws-user-name">{{ auth.account?.name }}</div>
          <div class="ws-user-sub">@{{ auth.account?.username }}</div>
        </div>
        <el-button text size="small" @click="logout">退出</el-button>
      </div>
    </aside>

    <!-- 主区域 -->
    <main class="home-main">
      <template v-if="selectedWs">
        <header class="home-header">
          <div>
            <h2 class="home-title">{{ selectedWs.name }}</h2>
            <span class="home-meta">{{ selectedWs.memberCount }} 成员 · {{ selectedWs.docCount }} 文档</span>
          </div>
          <div class="spacer" />
          <el-button v-if="isWsAdmin" plain @click="membersVisible = true">成员管理</el-button>
          <el-button type="primary" @click="creatingDoc = true">新建文档</el-button>
        </header>

        <section class="doc-grid">
          <div v-for="d in docs" :key="d.id" class="doc-card" @click="openDoc(d)">
            <div class="doc-card-icon">📄</div>
            <div class="doc-card-body">
              <div class="doc-card-title">{{ d.title }}</div>
              <div class="doc-card-time">更新于 {{ fmtTime(d.updatedAt) }}</div>
            </div>
            <div class="doc-card-side" @click.stop>
              <el-tag size="small" :type="roleTagType(d.myRole)">{{ ROLE_LABEL[d.myRole] }}</el-tag>
              <el-button
                v-if="d.myRole === 'manager'"
                size="small"
                text
                type="danger"
                :loading="entering === d.id"
                @click="permDoc = d"
              >
                权限
              </el-button>
            </div>
          </div>
          <el-empty v-if="docs.length === 0" description="暂无有权限的文档，点击右上角新建" />
        </section>
      </template>

      <!-- 未选择工作区：最近协作 -->
      <section v-else class="recent-pane">
        <h2>最近协作</h2>
        <div v-for="r in wsStore.recent" :key="r.doc.id" class="doc-card" @click="openDoc(r.doc)">
          <div class="doc-card-icon">🕘</div>
          <div class="doc-card-body">
            <div class="doc-card-title">{{ r.doc.title }}</div>
            <div class="doc-card-time">最近访问 {{ fmtTime(r.lastVisitedAt) }}</div>
          </div>
          <el-tag size="small" :type="roleTagType(r.doc.myRole)">{{ ROLE_LABEL[r.doc.myRole] }}</el-tag>
        </div>
      </section>
    </main>

    <!-- 新建工作区 -->
    <el-dialog v-model="creatingWs" title="新建工作区" width="420px">
      <el-input v-model="newWsName" placeholder="工作区名称，如：产品研发部" maxlength="60" @keyup.enter="createWorkspace" />
      <template #footer>
        <el-button @click="creatingWs = false">取消</el-button>
        <el-button type="primary" @click="createWorkspace">创建</el-button>
      </template>
    </el-dialog>

    <!-- 新建文档 -->
    <el-dialog v-model="creatingDoc" title="新建文档" width="420px">
      <el-input v-model="newDocTitle" placeholder="文档标题" maxlength="80" @keyup.enter="createDoc" />
      <template #footer>
        <el-button @click="creatingDoc = false">取消</el-button>
        <el-button type="primary" @click="createDoc">创建并进入</el-button>
      </template>
    </el-dialog>

    <!-- 工作区成员管理 -->
    <MembersDialog
      v-if="selectedWs"
      v-model:visible="membersVisible"
      :workspace-id="selectedWs.id"
      :admin="isWsAdmin"
      @changed="wsStore.refreshCurrent()"
    />

    <!-- 文档权限配置 -->
    <PermissionDialog
      v-if="permDoc"
      :doc="permDoc"
      @close="permDoc = null"
      @changed="wsStore.refreshCurrent()"
    />
  </div>
</template>

<style scoped>
.home-shell {
  display: flex;
  min-height: 100vh;
  background: #f5f7fa;
}
.ws-sidebar {
  width: 240px;
  background: #fff;
  border-right: 1px solid #ebeef5;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
}
.brand {
  font-size: 18px;
  font-weight: 700;
  padding: 4px 8px 16px;
}
.ws-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}
.ws-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.ws-item:hover {
  background: #f5f7fa;
}
.ws-item.active {
  background: #ecf5ff;
}
.ws-item.active .ws-name {
  color: #409eff;
  font-weight: 600;
}
.ws-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-add {
  margin: 8px 0;
  justify-content: flex-start;
}
.ws-user {
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid #ebeef5;
  padding-top: 12px;
}
.ws-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
}
.ws-user-info {
  flex: 1;
  min-width: 0;
}
.ws-user-name {
  font-size: 13px;
  font-weight: 600;
}
.ws-user-sub {
  font-size: 11px;
  color: #909399;
}
.home-main {
  flex: 1;
  padding: 28px 32px;
  overflow-y: auto;
}
.home-header {
  display: flex;
  align-items: center;
  margin-bottom: 20px;
}
.home-title {
  margin: 0 0 4px;
}
.home-meta {
  color: #909399;
  font-size: 13px;
}
.spacer {
  flex: 1;
}
.doc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.doc-card {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 10px;
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.doc-card:hover {
  border-color: #c6e2ff;
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.1);
}
.doc-card-icon {
  font-size: 24px;
}
.doc-card-body {
  flex: 1;
  min-width: 0;
}
.doc-card-title {
  font-weight: 600;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-card-time {
  font-size: 12px;
  color: #909399;
}
.doc-card-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.recent-pane h2 {
  margin-top: 0;
}
</style>
