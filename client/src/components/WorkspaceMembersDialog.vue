<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useWorkspaceStore } from '@/stores/workspace'
import type { WorkspaceMemberView, WorkspaceRole } from '../../../shared/tenant'

const ws = useWorkspaceStore()
const emit = defineEmits<{ close: [] }>()

const addVisible = ref(false)
const addForm = ref({ username: '', role: 'member' as WorkspaceRole })
const loading = ref(false)

async function refresh() {
  loading.value = true
  try {
    await ws.loadDocs()
  } finally {
    loading.value = false
  }
}

async function changeRole(m: WorkspaceMemberView, role: WorkspaceRole) {
  try {
    await ws.changeWorkspaceMember(m.userId, role)
    ElMessage.success('工作区角色已更新')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removeMember(m: WorkspaceMemberView) {
  try {
    await ElMessageBox.confirm(
      `确定将 ${m.user.displayName} 移出工作区吗？其名下所有文档授权将一并收回，在线连接立即退出。`,
      '移除工作区成员',
      { type: 'warning' },
    )
  } catch {
    return
  }
  try {
    await ws.removeWorkspaceMember(m.userId)
    ElMessage.success('已移出工作区')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function submitAdd() {
  if (!addForm.value.username.trim()) {
    ElMessage.warning('请输入用户登录名')
    return
  }
  try {
    await ws.addWorkspaceMember(addForm.value.username.trim(), addForm.value.role)
    ElMessage.success('已加入工作区')
    addVisible.value = false
    addForm.value = { username: '', role: 'member' }
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}
</script>

<template>
  <el-dialog :model-value="true" title="工作区成员" width="600px" @close="emit('close')">
    <div v-loading="loading" style="margin-bottom: 12px; display: flex; align-items: center">
      <span style="font-size: 13px; color: #909399">工作区管理员默认拥有区内所有文档的管理权</span>
      <div style="flex: 1" />
      <el-button type="primary" size="small" @click="addVisible = true">＋ 添加成员</el-button>
    </div>

    <el-table :data="ws.workspaceMembers" empty-text="暂无成员">
      <el-table-column label="成员" min-width="200">
        <template #default="{ row }: { row: WorkspaceMemberView }">
          <div style="display: flex; align-items: center; gap: 8px">
            <el-avatar :size="28" style="background: #409eff">{{ row.user.displayName.slice(0, 1) }}</el-avatar>
            <div>
              <div style="font-size: 13px">{{ row.user.displayName }}</div>
              <div style="font-size: 11px; color: #909399">@{{ row.user.username }}</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="工作区角色" width="180">
        <template #default="{ row }: { row: WorkspaceMemberView }">
          <el-select
            :model-value="row.role"
            size="small"
            style="width: 120px"
            @change="(v: WorkspaceRole) => changeRole(row, v)"
          >
            <el-option value="admin" label="管理员" />
            <el-option value="member" label="普通成员" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }: { row: WorkspaceMemberView }">
          <el-button size="small" text type="danger" @click="removeMember(row)">移出</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="addVisible" title="添加工作区成员" width="420px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="用户登录名" required>
          <el-input v-model="addForm.username" placeholder="对方需先完成注册" />
        </el-form-item>
        <el-form-item label="工作区角色">
          <el-radio-group v-model="addForm.role">
            <el-radio-button value="admin">管理员</el-radio-button>
            <el-radio-button value="member">普通成员</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAdd">添加</el-button>
      </template>
    </el-dialog>

    <template #footer>
      <el-button @click="emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>
