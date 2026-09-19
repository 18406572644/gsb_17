<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api/http'
import { useWorkspaceStore } from '@/stores/workspace'
import type { AuditEntry } from '../../../shared/tenant'

const props = defineProps<{ docId?: string; workspaceId?: boolean; title: string }>()
const emit = defineEmits<{ close: [] }>()

const ws = useWorkspaceStore()
const entries = ref<AuditEntry[]>([])
const loading = ref(true)

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const ACTION_TAG: Record<string, string> = {
  'doc.create': 'success',
  'doc.rename': '',
  'doc.delete': 'danger',
  'member.grant': 'warning',
  'member.update': 'warning',
  'member.remove': 'danger',
  'workspace.create': 'success',
  'workspace.member.add': '',
  'workspace.member.update': 'warning',
  'workspace.member.remove': 'danger',
}

onMounted(async () => {
  try {
    if (props.docId) {
      entries.value = (await api.docAudit(props.docId)).entries
    } else if (props.workspaceId) {
      entries.value = (await api.workspaceAudit(ws.currentWorkspaceId)).entries
    }
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <el-dialog :model-value="true" :title="title" width="720px" @close="emit('close')">
    <el-table v-loading="loading" :data="entries" height="460" empty-text="暂无审计记录">
      <el-table-column label="时间" width="170">
        <template #default="{ row }: { row: AuditEntry }">
          <span style="font-size: 12px">{{ fmtTime(row.at) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作人" width="120">
        <template #default="{ row }: { row: AuditEntry }">{{ row.actorName }}</template>
      </el-table-column>
      <el-table-column label="动作" width="170">
        <template #default="{ row }: { row: AuditEntry }">
          <el-tag size="small" :type="(ACTION_TAG[row.action] as any) || 'info'" effect="plain">
            {{ row.action }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="详情" min-width="240">
        <template #default="{ row }: { row: AuditEntry }">{{ row.detail }}</template>
      </el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>
