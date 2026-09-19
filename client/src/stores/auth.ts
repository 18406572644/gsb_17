import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api, clearToken, getToken, setToken } from '@/api'
import type { Account } from '../../../shared/api'

/** 全局登录态：当前账号、令牌、初始化状态 */
export const useAuthStore = defineStore('auth', () => {
  const account = ref<Account | null>(null)
  const token = ref(getToken())
  const ready = ref(false) // 首次 /me 校验是否完成

  const isLoggedIn = computed(() => !!account.value && !!token.value)

  async function login(username: string, password: string) {
    const res = await api.login({ username, password })
    token.value = res.token
    account.value = res.account
    setToken(res.token)
  }

  async function register(username: string, password: string, name: string) {
    const res = await api.register({ username, password, name })
    token.value = res.token
    account.value = res.account
    setToken(res.token)
  }

  /** 应用启动 / 刷新后用本地令牌恢复会话 */
  async function restore() {
    if (!token.value) {
      ready.value = true
      return
    }
    try {
      const res = await api.me()
      account.value = res.account
    } catch {
      account.value = null
      token.value = ''
      clearToken()
    } finally {
      ready.value = true
    }
  }

  async function logout() {
    try {
      await api.logout()
    } catch {
      /* 忽略网络错误，本地仍要登出 */
    }
    account.value = null
    token.value = ''
    clearToken()
  }

  return { account, token, ready, isLoggedIn, login, register, restore, logout }
})
