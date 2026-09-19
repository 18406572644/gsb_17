<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { ApiException } from '@/api'

const auth = useAuthStore()

const mode = ref<'login' | 'register'>('login')
const loading = ref(false)
const form = reactive({ username: '', password: '', name: '' })

const DEMO = [
  { username: 'alice', desc: '林安 · 产品研发部管理员' },
  { username: 'bob', desc: '王博文 · 编辑/批注' },
  { username: 'carol', desc: '陈晓艺 · 设计组管理员' },
  { username: 'dave', desc: '戴伟 · 查看/编辑' },
]

async function submit() {
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请填写登录名与密码')
    return
  }
  if (mode.value === 'register' && !form.name.trim()) {
    ElMessage.warning('请填写昵称')
    return
  }
  loading.value = true
  try {
    if (mode.value === 'login') {
      await auth.login(form.username.trim(), form.password)
    } else {
      await auth.register(form.username.trim(), form.password, form.name.trim())
    }
    ElMessage.success(mode.value === 'login' ? '登录成功' : '注册成功，已自动登录')
  } catch (e) {
    ElMessage.error(e instanceof ApiException ? e.message : '登录失败，请重试')
  } finally {
    loading.value = false
  }
}

function fillDemo(username: string) {
  mode.value = 'login'
  form.username = username
  form.password = 'demo1234'
}
</script>

<template>
  <div class="auth-wrap">
    <el-card class="auth-card">
      <h2 class="auth-title">企业协同文档工作台</h2>
      <p class="auth-sub">多工作区 · 细粒度文档权限 · 实时协同与在线改权</p>

      <el-tabs v-model="mode" stretch>
        <el-tab-pane label="登录" name="login" />
        <el-tab-pane label="注册" name="register" />
      </el-tabs>

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="登录名">
          <el-input v-model="form.username" placeholder="3-20 位字母/数字/下划线" clearable />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item v-if="mode === 'register'" label="昵称">
          <el-input v-model="form.name" maxlength="24" placeholder="显示给协作者的名称" />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="loading" @click="submit">
          {{ mode === 'login' ? '登录' : '注册并登录' }}
        </el-button>
      </el-form>

      <el-divider>演示账号（密码 demo1234）</el-divider>
      <div class="demo-list">
        <div v-for="d in DEMO" :key="d.username" class="demo-item" @click="fillDemo(d.username)">
          <el-tag size="small" effect="plain">{{ d.username }}</el-tag>
          <span class="demo-desc">{{ d.desc }}</span>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.auth-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f0f5ff 0%, #e8f5e9 100%);
  padding: 24px;
}
.auth-card {
  width: 420px;
  max-width: 100%;
}
.auth-title {
  margin: 4px 0 4px;
  font-size: 22px;
}
.auth-sub {
  margin: 0 0 8px;
  color: #909399;
  font-size: 13px;
}
.demo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.demo-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.demo-item:hover {
  background: #f5f7fa;
}
.demo-desc {
  font-size: 12px;
  color: #606266;
}
</style>
