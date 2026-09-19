import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { User } from '../../../shared/tenant'
import { api, clearToken, getToken, setToken } from '@/api/http'

/** 登录身份与令牌；应用启动时用 localStorage 中的令牌恢复会话 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const token = ref<string>(getToken())
  const bootstrapped = ref(false)
  const loading = ref(false)

  const isLoggedIn = computed(() => !!user.value && !!token.value)
  const displayName = computed(() => user.value?.displayName || '')

  /** 应用挂载时调用：令牌有效则恢复用户 */
  async function bootstrap(): Promise<void> {
    if (bootstrapped.value) return
    bootstrapped.value = true
    if (!token.value) return
    try {
      const res = await api.me()
      user.value = res.user
    } catch {
      // 令牌失效（例如服务端重启）：清除本地登录态
      token.value = ''
      clearToken()
    }
  }

  async function login(username: string, password: string) {
    loading.value = true
    try {
      const res = await api.login({ username, password })
      token.value = res.token
      user.value = res.user
      setToken(res.token)
    } finally {
      loading.value = false
    }
  }

  async function register(username: string, password: string, displayName?: string) {
    loading.value = true
    try {
      const res = await api.register({ username, password, displayName })
      token.value = res.token
      user.value = res.user
      setToken(res.token)
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    try {
      await api.logout()
    } catch {
      // 忽略网络错误，本地态始终清除
    }
    token.value = ''
    user.value = null
    clearToken()
  }

  return {
    user,
    token,
    bootstrapped,
    loading,
    isLoggedIn,
    displayName,
    bootstrap,
    login,
    register,
    logout,
  }
})
