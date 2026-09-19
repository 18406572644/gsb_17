<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, ApiException } from '@/api'
import { useAuthStore } from '@/stores/auth'
import { WORKSPACE_ROLE_LABEL } from '../../../shared/api'
import type { WorkspaceMember, WorkspaceRole } from '../../../shared/api'

const props = defineProps<{ visible: boolean; workspaceId: string; admin: boolean }>()
const emit = defineEmits<{
  'update:visible': [v: boolean]
  changed: []
}>()

const auth = useAuthStore()
const members = ref<WorkspaceMember[]>([])
const loading = ref(false)
const addForm = ref({ username: '', role: 'member' as WorkspaceRole })
const adding = ref(false)

const visibleModel = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v),
})

async function load() {
  loading.value = true
  try {
    const detail = await api.workspace(props.workspaceId)
    members.value = detail.members
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '加载成员失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) load()
  },
)

async function addMember() {
  if (!addForm.value.username.trim()) {
    ElMessage.warning('请填写对方登录名')
    return
  }
  adding.value = true
  try {
    await api.addMember(props.workspaceId, {
      username: addForm.value.username.trim(),
      role: addForm.value.role,
    })
    addForm.value.username = ''
    ElMessage.success('已添加成员')
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '添加失败')
  } finally {
    adding.value = false
  }
}

async function changeRole(m: WorkspaceMember, role: WorkspaceRole) {
  try {
    await api.updateMemberRole(props.workspaceId, m.userId, { role })
    ElMessage.success('成员角色已更新（在线者实时生效）')
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '更新失败')
  }
}

async function remove(m: WorkspaceMember) {
  try {
    await ElMessageBox.confirm(`确定将 ${m.name} 移出工作区吗？其全部文档权限将被收回。`, '移除成员', {
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await api.removeMember(props.workspaceId, m.userId)
    ElMessage.success('已移除，在线会话将被断开')
    await load()
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '移除失败')
  }
}
</script>

<template>
  <el-dialog v-model="visibleModel" title="工作区成员管理" width="560px">
    <div v-loading="loading">
      <!-- 添加成员（仅管理员） -->
      <div v-if="admin" class="add-bar">
        <el-input v-model="addForm.username" placeholder="按登录名添加成员" size="default" />
        <el-select v-model="addForm.role" style="width: 120px">
          <el-option label="成员" value="member" />
          <el-option label="管理员" value="admin" />
        </el-select>
        <el-button type="primary" :loading="adding" @click="addMember">添加</el-button>
      </div>

      <el-table :data="members" style="width: 100%" size="small">
        <el-table-column label="成员" min-width="180">
          <template #default="{ row }: { row: WorkspaceMember }">
            <div class="member-cell">
              <span class="member-avatar" :style="{ background: row.color }">{{ row.name.slice(0, 1) }}</span>
              <div>
                <div class="member-name">
                  {{ row.name }}
                  <span v-if="row.userId === auth.account?.id" class="me">（我）</span>
                </div>
                <div class="member-sub">@{{ row.username }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="工作区角色" width="190">
          <template #default="{ row }: { row: WorkspaceMember }">
            <el-select
              :model-value="row.role"
              size="small"
              :disabled="!admin || row.userId === auth.account?.id"
              style="width: 130px"
              @change="(v: WorkspaceRole) => changeRole(row, v)"
            >
              <el-option label="管理员" value="admin" />
              <el-option label="成员" value="member" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column width="80">
          <template #default="{ row }: { row: WorkspaceMember }">
            <el-button
              v-if="admin && row.userId !== auth.account?.id"
              size="small"
              text
              type="danger"
              @click="remove(row)"
            >
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="hint">{{ WORKSPACE_ROLE_LABEL.admin }}对工作区内所有文档隐式拥有「管理」权限。</p>
    </div>
  </el-dialog>
</template>

<style scoped>
.add-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.member-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.member-avatar {
  width: 30px;
  height: 30px;
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
.me {
  color: #909399;
  font-weight: 400;
}
.member-sub {
  font-size: 11px;
  color: #909399;
}
.hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: #909399;
}
</style>
