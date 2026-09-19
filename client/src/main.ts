import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import App from './App.vue'
import './style.css'
import { useAuthStore } from './stores/auth'

const app = createApp(App)
app.use(createPinia())
app.use(ElementPlus, { locale: zhCn })

// 挂载前用本地令牌恢复登录态（失败则停留在登录页）
const auth = useAuthStore()
auth.restore().finally(() => app.mount('#app'))
