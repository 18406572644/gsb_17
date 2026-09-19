<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, ApiException } from '@/api'
import { ROLE_LABEL } from '../../../shared/protocol'
import type { Role } from '../../../shared/protocol'
import { WORKSPACE_ROLE_LABEL } from '../../../shared/api'
import type { AuditEntry, DocMeta, DocPermission, WorkspaceMember } from '../../../shared/api'

const props = defineProps<{ doc: DocMeta }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const permissions = ref<DocPermission[]>([])
const members = ref<WorkspaceMember[]>([])
const audit = ref<AuditEntry[]>([])
const loading = ref(false)
const savingUser = ref<string>('')
const auditVisible = ref(false)
const pickedUser = ref('')
const pickedRole = ref<Role>('viewer')
const granting = ref(false)

/** 尚无显式授权、可被新增授权的普通成员（admin 隐式 manager，无需授权） */
const candidates = computed(() => {
  const have = new Set(permissions.value.map((p) => p.userId))
  return members.value.filter((m) => m.role !== 'admin' && !have.has(m.userId))
})

async function load() {
  loading.value = true
  try {
    const [detail, plist] = await Promise.all([
      api.workspace(props.doc.workspaceId),
      api.permissions(props.doc.workspaceId, props.doc.id),
    ])
    members.value = detail.members
    permissions.value = plist.permissions
    audit.value = plist.audit
    if (!candidates.value.some((c) => c.userId === pickedUser.value)) pickedUser.value = ''
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '加载权限失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => props.doc.id,
  () => load(),
  { immediate: true },
)

async function setRole(p: DocPermission, value: Role | '') {
  if (p.implicit) return
  savingUser.value = p.userId
  try {
    const role = value === '' ? null : value
    await api.setPermission(props.doc.workspaceId, props.doc.id, { userId: p.userId, role })
    ElMessage.success(role === null ? '已移除该成员的文档权限' : `已设置为「${ROLE_LABEL[role]}」，在线者实时生效`)
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '保存失败')
  } finally {
    savingUser.value = ''
  }
}

async function grant() {
  if (!pickedUser.value) return
  granting.value = true
  try {
    await api.setPermission(props.doc.workspaceId, props.doc.id, {
      userId: pickedUser.value,
      role: pickedRole.value,
    })
    ElMessage.success('已授权，在线者实时生效')
    pickedUser.value = ''
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '授权失败')
  } finally {
    granting.value = false
  }
}

function roleLabelFor(a: AuditEntry, v: string | null): string {
  if (v === null) return '无权限'
  if (a.kind === 'workspace-role') return WORKSPACE_ROLE_LABEL[v as 'admin' | 'member'] ?? v
  return ROLE_LABEL[v as Role] ?? v
}

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
</script>

<template>
  <el-dialog :model-value="true" :title="`文档权限 · ${doc.title}`" width="620px" @close="emit('close')">
    <div v-loading="loading">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 12px"
        title="为工作区成员配置查看 / 批注 / 编辑 / 管理权限；调整对正在编辑的用户实时生效，降权会立即拦截其在途操作。"
      />

      <el-table :data="permissions" size="small" style="width: 100%">
        <el-table-column label="成员" min-width="180">
          <template #default="{ row }: { row: DocPermission }">
            <div class="member-cell">
              <span class="member-avatar" :style="{ background: row.color }">{{ row.name.slice(0, 1) }}</span>
              <div>
                <div class="member-name">{{ row.name }}</div>
                <div class="member-sub">@{{ row.username }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="权限" width="250">
          <template #default="{ row }: { row: DocPermission }">
            <el-select
              :model-value="row.implicit ? '' : row.role"
              size="small"
              :disabled="row.implicit || savingUser === row.userId"
              style="width: 130px"
              @change="(v: Role | '') => setRole(row, v)"
            >
              <el-option label="查看" value="viewer" />
              <el-option label="批注" value="commenter" />
              <el-option label="编辑" value="editor" />
              <el-option label="管理" value="manager" />
              <el-option label="移除权限" value="" />
            </el-select>
            <el-tag v-if="row.implicit" size="small" type="danger" effect="plain" style="margin-left: 6px">
              工作区管理员
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <!-- 为更多成员授权 -->
      <div v-if="candidates.length" class="add-grant">
        <div class="add-grant-title">为更多成员授权</div>
        <div class="add-grant-bar">
          <el-select v-model="pickedUser" size="small" placeholder="选择成员…" style="flex: 1">
            <el-option
              v-for="c in candidates"
              :key="c.userId"
              :label="`${c.name} (@${c.username})`"
              :value="c.userId"
            />
          </el-select>
          <el-select v-model="pickedRole" size="small" style="width: 100px">
            <el-option label="查看" value="viewer" />
            <el-option label="批注" value="commenter" />
            <el-option label="编辑" value="editor" />
            <el-option label="管理" value="manager" />
          </el-select>
          <el-button size="small" type="primary" :disabled="!pickedUser" :loading="granting" @click="grant">
            授权
          </el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="auditVisible = true">查看权限变更审计</el-button>
      <el-button type="primary" @click="emit('close')">完成</el-button>
    </template>

    <!-- 审计记录抽屉 -->
    <el-drawer v-model="auditVisible" title="权限变更审计" size="460px">
      <el-timeline style="padding-left: 8px">
        <el-timeline-item
          v-for="a in audit"
          :key="a.id"
          :timestamp="fmtTime(a.createdAt)"
          placement="top"
          :type="a.toRole === null ? 'danger' : 'primary'"
        >
          <div class="audit-line">
            <b>{{ a.operatorName }}</b>
            将 <b>{{ a.targetUserName }}</b> 的{{ a.kind === 'workspace-role' ? '工作区角色' : '文档权限' }}
            从 <el-tag size="small" effect="plain">{{ roleLabelFor(a, a.fromRole) }}</el-tag>
            调整为
            <el-tag size="small" :type="a.toRole === null ? 'danger' : 'success'" effect="plain">
              {{ roleLabelFor(a, a.toRole) }}
            </el-tag>
          </div>
          <div v-if="a.docTitle" class="audit-doc">文档：{{ a.docTitle }}</div>
        </el-timeline-item>
        <el-empty v-if="audit.length === 0" description="暂无权限变更记录" :image-size="80" />
      </el-timeline>
    </el-drawer>
  </el-dialog>
</template>

<style scoped>
.member-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}
.member-name {
  font-weight: 600;
  font-size: 13px;
}
.member-sub {
  font-size: 11px;
  color: #909399;
}
.add-grant {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed #ebeef5;
}
.add-grant-title {
  font-size: 13px;
  color: #606266;
  font-weight: 600;
  margin-bottom: 8px;
}
.add-grant-bar {
  display: flex;
  gap: 8px;
}
.audit-line {
  font-size: 13px;
  line-height: 1.9;
}
.audit-doc {
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
}
</style>
