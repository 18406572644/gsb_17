<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import { ApiError } from '@/api/http'

const auth = useAuthStore()

const mode = ref<'login' | 'register'>('login')
const form = reactive({ username: '', password: '', displayName: '' })
const confirmPassword = ref('')

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', desc: '工作区/文档管理员' },
  { username: 'editor', password: 'editor123', desc: '编辑员' },
  { username: 'commenter', password: 'commenter123', desc: '批注员' },
  { username: 'viewer', password: 'viewer123', desc: '只读访客' },
]

function fill(u: string, p: string) {
  form.username = u
  form.password = p
}

async function submit() {
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请输入登录名与密码')
    return
  }
  if (mode.value === 'register' && form.password !== confirmPassword.value) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }
  try {
    if (mode.value === 'login') {
      await auth.login(form.username.trim(), form.password)
    } else {
      await auth.register(form.username.trim(), form.password, form.displayName.trim() || undefined)
    }
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '登录失败，请稍后重试')
  }
}
</script>

<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2 class="login-title">企业协同文档工作区</h2>
      <p class="login-sub">多文档工作区 · 查看/批注/编辑/管理细粒度权限 · 在线降权实时拦截</p>

      <el-tabs v-model="mode" stretch>
        <el-tab-pane label="登录" name="login" />
        <el-tab-pane label="注册" name="register" />
      </el-tabs>

      <el-form label-position="top" @submit.prevent>
        <el-form-item label="登录名">
          <el-input v-model="form.username" placeholder="3-20 位字母、数字、下划线或连字符" clearable />
        </el-form-item>
        <el-form-item v-if="mode === 'register'" label="显示名称">
          <el-input v-model="form.displayName" maxlength="24" placeholder="可选，展示给协作者的名字" clearable />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item v-if="mode === 'register'" label="确认密码">
          <el-input v-model="confirmPassword" type="password" show-password placeholder="再次输入密码" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="auth.loading" @click="submit">
          {{ mode === 'login' ? '登录' : '注册并登录' }}
        </el-button>
      </el-form>

      <div class="demo-hint">
        <p class="demo-title">演示账号（点击自动填充）</p>
        <div v-for="a in DEMO_ACCOUNTS" :key="a.username" class="demo-row" @click="fill(a.username, a.password)">
          <el-tag size="small" effect="plain">{{ a.username }}</el-tag>
          <span class="demo-desc">{{ a.desc }}</span>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.login-card {
  width: 440px;
}
.demo-hint {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed #e4e7ed;
}
.demo-title {
  margin: 0 0 8px;
  font-size: 12px;
  color: #909399;
}
.demo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
  font-size: 12px;
  color: #606266;
}
.demo-row:hover {
  color: #409eff;
}
.demo-desc {
  color: #909399;
}
</style>
