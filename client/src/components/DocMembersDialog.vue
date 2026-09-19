<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '@/api/http'
import { useWorkspaceStore } from '@/stores/workspace'
import { ROLE_LABEL, type Role } from '../../../shared/protocol'
import type { DocListItem, DocMemberView } from '../../../shared/tenant'

const props = defineProps<{ docItem: DocListItem }>()
const emit = defineEmits<{ close: [] }>()

const ws = useWorkspaceStore()
const members = ref<DocMemberView[]>([])
const loading = ref(false)
const addVisible = ref(false)
const addForm = ref({ username: '', role: 'commenter' as Role })

const ROLES: Role[] = ['viewer', 'commenter', 'editor', 'admin']
const ROLE_DESC: Record<Role, string> = {
  viewer: '仅查看文档与批注',
  commenter: '可查看并添加/回复批注',
  editor: '可编辑正文与批注',
  admin: '可管理成员、删除文档（兼具编辑权）',
}
const ROLE_TAG: Record<Role, '' | 'success' | 'warning' | 'info' | 'danger'> = {
  admin: 'danger',
  editor: '',
  commenter: 'warning',
  viewer: 'info',
}

async function load() {
  loading.value = true
  try {
    members.value = (await api.listDocMembers(props.docItem.doc.id)).members
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function changeRole(m: DocMemberView, role: Role) {
  try {
    await api.grantDocMember(props.docItem.doc.id, { username: m.user.username, role })
    ElMessage.success(`已将 ${m.user.displayName} 调整为「${ROLE_LABEL[role]}」`)
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removeMember(m: DocMemberView) {
  try {
    await ElMessageBox.confirm(`确定移除成员 ${m.user.displayName} 吗？其在线连接将被立即退出文档。`, '移除成员', {
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await api.revokeDocMember(props.docItem.doc.id, m.userId)
    ElMessage.success('已移除')
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function submitAdd() {
  if (!addForm.value.username.trim()) {
    ElMessage.warning('请输入要授权的用户登录名')
    return
  }
  try {
    await api.grantDocMember(props.docItem.doc.id, {
      username: addForm.value.username.trim(),
      role: addForm.value.role,
    })
    ElMessage.success('授权成功，若对方正在线将立即生效')
    addVisible.value = false
    addForm.value = { username: '', role: 'commenter' }
    await load()
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

/** 工作区成员里尚未被授权的人（提示用） */
const candidates = () =>
  ws.workspaceMembers.filter((wm) => !members.value.some((m) => m.userId === wm.userId)).map((wm) => wm.user.username)
</script>

<template>
  <el-dialog :model-value="true" :title="`成员权限 · ${props.docItem.doc.title}`" width="640px" @close="emit('close')">
    <div v-loading="loading">
      <div style="margin-bottom: 12px; display: flex; align-items: center">
        <span style="font-size: 13px; color: #909399">细粒度角色：查看 / 批注 / 编辑 / 管理，调整后实时生效</span>
        <div style="flex: 1" />
        <el-button type="primary" size="small" @click="addVisible = true">＋ 添加成员</el-button>
      </div>

      <el-table :data="members" empty-text="暂无成员">
        <el-table-column label="成员" min-width="180">
          <template #default="{ row }: { row: DocMemberView }">
            <div style="display: flex; align-items: center; gap: 8px">
              <el-avatar :size="28" style="background: #409eff">{{ row.user.displayName.slice(0, 1) }}</el-avatar>
              <div>
                <div style="font-size: 13px">{{ row.user.displayName }}</div>
                <div style="font-size: 11px; color: #909399">@{{ row.user.username }}</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="220">
          <template #default="{ row }: { row: DocMemberView }">
            <el-select
              :model-value="row.role"
              size="small"
              style="width: 110px"
              @change="(v: Role) => changeRole(row, v)"
            >
              <el-option v-for="r in ROLES" :key="r" :value="r" :label="ROLE_LABEL[r]" />
            </el-select>
            <el-tag size="small" :type="ROLE_TAG[row.role]" effect="plain" style="margin-left: 6px">
              {{ ROLE_DESC[row.role] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }: { row: DocMemberView }">
            <el-button size="small" text type="danger" @click="removeMember(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 添加成员 -->
    <el-dialog v-model="addVisible" title="添加文档成员" width="440px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="用户登录名" required>
          <el-input v-model="addForm.username" placeholder="对方须已是同一工作区成员" />
          <div v-if="candidates().length" class="candidate-hint">
            可授权：
            <el-link v-for="u in candidates()" :key="u" type="primary" :underline="false" @click="addForm.username = u">
              {{ u }}
            </el-link>
          </div>
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="addForm.role">
            <el-radio-button v-for="r in ROLES" :key="r" :value="r">{{ ROLE_LABEL[r] }}</el-radio-button>
          </el-radio-group>
          <div class="role-desc">{{ ROLE_DESC[addForm.role] }}</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAdd">授权</el-button>
      </template>
    </el-dialog>

    <template #footer>
      <el-button @click="emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.candidate-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #909399;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.role-desc {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
</style>
