import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  canAnnotate as roleCanAnnotate,
  canEdit as roleCanEdit,
  canManage as roleCanManage,
  type Role,
  type UserInfo,
} from '../../../shared/protocol'
import type { ConnStatus } from '@/ws/wsClient'

/** 会话状态：连接、身份、当前文档、动态权限、在线用户、远程光标 */
export const useSessionStore = defineStore('session', () => {
  const joined = ref(false)
  const workspaceId = ref('')
  const docId = ref('')
  const docTitle = ref('')
  const name = ref('')
  const userId = ref('')
  const clientId = ref('')
  /** 当前有效角色：随管理员在线改权实时更新 */
  const role = ref<Role>('viewer')
  const users = ref<UserInfo[]>([])
  /** 光标按连接 ID 索引（携带 userId 供渲染） */
  const cursors = ref<Record<string, { userId: string; start: number; end: number }>>({})
  const status = ref<ConnStatus>('offline')
  const reconnectAttempt = ref(0)
  /** 用户手动模拟断网 */
  const simulatedOffline = ref(false)
  /** 权限被服务端收回（收到 4003 / perm:update null），停止自动重连 */
  const accessRevoked = ref(false)
  /** 降权提示（管理员在线调整） */
  const permissionNotice = ref<string | null>(null)

  const canEdit = computed(() => roleCanEdit(role.value))
  const canAnnotate = computed(() => roleCanAnnotate(role.value))
  const canManage = computed(() => roleCanManage(role.value))
  const online = computed(() => status.value === 'online')

  function setUsers(list: UserInfo[]) {
    users.value = list
    // 清理已离开账号的光标（按账号）
    const ids = new Set(list.map((u) => u.userId))
    for (const [cid, c] of Object.entries(cursors.value)) {
      if (!ids.has(c.userId)) delete cursors.value[cid]
    }
  }

  function setRole(r: Role) {
    role.value = r
  }

  function $reset() {
    joined.value = false
    workspaceId.value = ''
    docId.value = ''
    docTitle.value = ''
    name.value = ''
    userId.value = ''
    clientId.value = ''
    role.value = 'viewer'
    users.value = []
    cursors.value = {}
    status.value = 'offline'
    reconnectAttempt.value = 0
    simulatedOffline.value = false
    accessRevoked.value = false
    permissionNotice.value = null
  }

  return {
    joined,
    workspaceId,
    docId,
    docTitle,
    name,
    userId,
    clientId,
    role,
    users,
    cursors,
    status,
    reconnectAttempt,
    simulatedOffline,
    accessRevoked,
    permissionNotice,
    canEdit,
    canAnnotate,
    canManage,
    online,
    setUsers,
    setRole,
    $reset,
  }
})
