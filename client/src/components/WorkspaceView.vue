<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { useWorkspaceStore } from '@/stores/workspace'
import { collab } from '@/collab/collab'
import { api } from '@/api/http'
import { ROLE_LABEL } from '../../../shared/protocol'
import type { DocListItem } from '../../../shared/tenant'
import DocMembersDialog from '@/components/DocMembersDialog.vue'
import AuditDialog from '@/components/AuditDialog.vue'
import WorkspaceMembersDialog from '@/components/WorkspaceMembersDialog.vue'

const auth = useAuthStore()
const ws = useWorkspaceStore()

const loading = ref(true)
const loadError = ref('')

const newWsVisible = ref(false)
const newWsForm = ref({ name: '', description: '' })
const newDocVisible = ref(false)
const newDocTitle = ref('')

const membersDialogDoc = ref<DocListItem | null>(null)
const auditDialogDoc = ref<DocListItem | null>(null)
const wsMembersVisible = ref(false)
const wsAuditVisible = ref(false)

const isWsAdmin = computed(() => ws.currentWorkspaceRole === 'admin')

const ROLE_TAG: Record<string, '' | 'success' | 'warning' | 'info' | 'danger'> = {
  admin: 'danger',
  editor: '',
  commenter: 'warning',
  viewer: 'info',
}

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function refresh() {
  loading.value = true
  loadError.value = ''
  try {
    await ws.loadWorkspaces()
  } catch (e) {
    loadError.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

/** 进入编辑器：先经 HTTP 加载权限（openDoc），再建立协同连接 */
async function openDoc(docId: string) {
  try {
    await ws.openDoc(docId)
    collab.join(docId)
  } catch (e) {
    ElMessage.error((e as Error).message)
    await refresh()
  }
}

async function submitNewWorkspace() {
  if (!newWsForm.value.name.trim()) {
    ElMessage.warning('请输入工作区名称')
    return
  }
  try {
    await ws.createWorkspace(newWsForm.value.name.trim(), newWsForm.value.description.trim())
    newWsVisible.value = false
    newWsForm.value = { name: '', description: '' }
    ElMessage.success('工作区已创建')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function submitNewDoc() {
  if (!newDocTitle.value.trim()) {
    ElMessage.warning('请输入文档标题')
    return
  }
  try {
    const doc = await ws.createDoc(newDocTitle.value.trim())
    newDocVisible.value = false
    newDocTitle.value = ''
    await refresh()
    await ws.openDoc(doc.id)
    collab.join(doc.id)
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function renameDoc(item: DocListItem) {
  try {
    const { value } = await ElMessageBox.prompt('请输入新的文档标题', '重命名文档', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: item.doc.title,
    })
    if (value && value.trim()) {
      await api.renameDoc(item.doc.id, { title: value.trim() })
      await refresh()
    }
  } catch {
    // 用户取消
  }
}

async function removeDoc(item: DocListItem) {
  try {
    await ElMessageBox.confirm(`确定删除文档「${item.doc.title}」吗？此操作不可恢复。`, '删除文档', {
      type: 'warning',
      confirmButtonText: '删除',
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return
  }
  try {
    await ws.deleteDoc(item.doc.id)
    ElMessage.success('文档已删除')
    await refresh()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function logout() {
  await auth.logout()
}
</script>

<template>
  <div class="workspace-shell">
    <!-- 工作区侧栏 -->
    <aside class="ws-sidebar">
      <div class="ws-brand">📚 企业文档工作区</div>
      <div class="ws-list">
        <div
          v-for="w in ws.workspaces"
          :key="w.workspace.id"
          class="ws-item"
          :class="{ active: w.workspace.id === ws.currentWorkspaceId }"
          @click="ws.selectWorkspace(w.workspace.id)"
        >
          <div class="ws-item-name">{{ w.workspace.name }}</div>
          <div class="ws-item-meta">
            <el-tag size="small" :type="w.role === 'admin' ? 'danger' : 'info'" effect="plain">
              {{ w.role === 'admin' ? '管理员' : '成员' }}
            </el-tag>
            <span>{{ w.docCount }} 篇文档</span>
          </div>
        </div>
        <el-button class="ws-add" text type="primary" @click="newWsVisible = true">＋ 新建工作区</el-button>
      </div>
      <div class="ws-user">
        <el-avatar :size="30" style="background: #409eff">{{ (auth.displayName || '?').slice(0, 1) }}</el-avatar>
        <div class="ws-user-info">
          <div class="ws-user-name">{{ auth.displayName }}</div>
          <div class="ws-user-id">@{{ auth.user?.username }}</div>
        </div>
        <el-button text size="small" @click="logout">退出</el-button>
      </div>
    </aside>

    <!-- 主区域 -->
    <main class="ws-main">
      <div v-loading="loading" class="ws-content">
        <template v-if="ws.currentWorkspace">
          <header class="ws-header">
            <div>
              <h2 class="ws-title">{{ ws.currentWorkspace.name }}</h2>
              <p class="ws-desc">{{ ws.currentWorkspace.description || '暂无工作区说明' }}</p>
            </div>
            <div class="ws-actions">
              <el-button v-if="isWsAdmin" plain @click="wsAuditVisible = true">工作区审计</el-button>
              <el-button v-if="isWsAdmin" plain @click="wsMembersVisible = true">成员管理</el-button>
              <el-button type="primary" @click="newDocVisible = true">＋ 新建文档</el-button>
            </div>
          </header>

          <!-- 最近协作 -->
          <section v-if="ws.recent.length" class="recent-section">
            <h3 class="section-title">最近协作</h3>
            <div class="recent-list">
              <div
                v-for="r in ws.recent.filter((x) => x.workspaceId === ws.currentWorkspaceId).slice(0, 6)"
                :key="r.docId"
                class="recent-chip"
                @click="openDoc(r.docId)"
              >
                📄 {{ r.title }}
              </div>
            </div>
          </section>

          <!-- 文档目录 -->
          <section class="doc-section">
            <h3 class="section-title">文档目录（{{ ws.docs.length }}）</h3>
            <el-table :data="ws.docs" style="width: 100%" empty-text="该工作区还没有文档，或你尚未被授权任何文档">
              <el-table-column label="文档" min-width="280">
                <template #default="{ row }: { row: DocListItem }">
                  <a class="doc-link" @click="openDoc(row.doc.id)">{{ row.doc.title }}</a>
                </template>
              </el-table-column>
              <el-table-column label="我的角色" width="110">
                <template #default="{ row }: { row: DocListItem }">
                  <el-tag size="small" :type="ROLE_TAG[row.role || 'viewer']" effect="dark">
                    {{ ROLE_LABEL[row.role || 'viewer'] }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="更新时间" width="170">
                <template #default="{ row }: { row: DocListItem }">{{ fmtTime(row.doc.updatedAt) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="260">
                <template #default="{ row }: { row: DocListItem }">
                  <el-button size="small" text type="primary" @click="openDoc(row.doc.id)">打开</el-button>
                  <el-button
                    v-if="row.role === 'admin'"
                    size="small"
                    text
                    type="warning"
                    @click="membersDialogDoc = row"
                  >权限</el-button>
                  <el-button v-if="row.role === 'admin'" size="small" text type="info" @click="auditDialogDoc = row">审计</el-button>
                  <el-button v-if="row.role === 'admin'" size="small" text @click="renameDoc(row)">重命名</el-button>
                  <el-button v-if="row.role === 'admin'" size="small" text type="danger" @click="removeDoc(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </template>
        <el-empty v-else-if="!loading && !loadError" description="还没有工作区，点击左上角新建一个吧" />
        <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" />
      </div>
    </main>

    <!-- 新建工作区 -->
    <el-dialog v-model="newWsVisible" title="新建工作区" width="440px">
      <el-form label-position="top">
        <el-form-item label="工作区名称" required>
          <el-input v-model="newWsForm.name" maxlength="50" placeholder="例如：产品研发中心" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="newWsForm.description" type="textarea" :rows="2" maxlength="200" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="newWsVisible = false">取消</el-button>
        <el-button type="primary" @click="submitNewWorkspace">创建</el-button>
      </template>
    </el-dialog>

    <!-- 新建文档 -->
    <el-dialog v-model="newDocVisible" title="新建文档" width="440px">
      <el-input v-model="newDocTitle" maxlength="100" placeholder="文档标题" @keyup.enter="submitNewDoc" />
      <template #footer>
        <el-button @click="newDocVisible = false">取消</el-button>
        <el-button type="primary" @click="submitNewDoc">创建并打开</el-button>
      </template>
    </el-dialog>

    <!-- 文档成员权限管理 -->
    <DocMembersDialog v-if="membersDialogDoc" :doc-item="membersDialogDoc" @close="membersDialogDoc = null" />
    <!-- 文档审计 -->
    <AuditDialog
      v-if="auditDialogDoc"
      :doc-id="auditDialogDoc.doc.id"
      :title="`文档审计 · ${auditDialogDoc.doc.title}`"
      @close="auditDialogDoc = null"
    />
    <!-- 工作区审计 -->
    <AuditDialog v-if="wsAuditVisible" workspace-id :title="`工作区审计 · ${ws.currentWorkspace?.name || ''}`" @close="wsAuditVisible = false" />
    <!-- 工作区成员 -->
    <WorkspaceMembersDialog v-if="wsMembersVisible" @close="wsMembersVisible = false" />
  </div>
</template>
