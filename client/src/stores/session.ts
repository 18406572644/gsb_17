import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { canAnnotate, canEdit, canManage, type Role, type UserInfo } from '../../../shared/protocol'
import type { ConnStatus } from '@/ws/wsClient'

/** 会话状态：连接、服务端解析的身份与角色、在线用户、远程光标 */
export const useSessionStore = defineStore('session', () => {
  /** 是否处于编辑器内（进入工作台后由 collab 置位） */
  const joined = ref(false)
  const docId = ref('')
  const workspaceId = ref('')
  const docTitle = ref('')
  /** 当前登录用户的稳定 ID */
  const userId = ref('')
  const name = ref('')
  /** 服务端根据成员关系下发的有效角色（权限实时变更时更新） */
  const role = ref<Role>('viewer')
  const clientId = ref('')
  const users = ref<UserInfo[]>([])
  const cursors = ref<Record<string, { start: number; end: number }>>({})
  const status = ref<ConnStatus>('offline')
  const reconnectAttempt = ref(0)
  /** 用户手动模拟断网 */
  const simulatedOffline = ref(false)

  const canEditDoc = computed(() => canEdit(role.value))
  const canAnnotateDoc = computed(() => canAnnotate(role.value))
  const canAdminDoc = computed(() => canManage(role.value))
  const online = computed(() => status.value === 'online')

  function setUsers(list: UserInfo[]) {
    users.value = list
    // 清理已离开用户的光标
    const ids = new Set(list.map((u) => u.clientId))
    for (const id of Object.keys(cursors.value)) {
      if (!ids.has(id)) delete cursors.value[id]
    }
  }

  function $reset() {
    joined.value = false
    docId.value = ''
    workspaceId.value = ''
    docTitle.value = ''
    userId.value = ''
    name.value = ''
    role.value = 'viewer'
    clientId.value = ''
    users.value = []
    cursors.value = {}
    status.value = 'offline'
    reconnectAttempt.value = 0
    simulatedOffline.value = false
  }

  return {
    joined,
    docId,
    workspaceId,
    docTitle,
    userId,
    name,
    role,
    clientId,
    users,
    cursors,
    status,
    reconnectAttempt,
    simulatedOffline,
    canEditDoc,
    canAnnotateDoc,
    canAdminDoc,
    online,
    setUsers,
    $reset,
  }
})
