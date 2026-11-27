<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  ConfigProvider,
  Layout,
  LayoutSider,
  LayoutHeader,
  LayoutContent,
  Menu,
  MenuItem,
  Avatar,
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  Tag,
} from 'ant-design-vue';
import { TeamOutlined, HistoryOutlined } from '@ant-design/icons-vue';
import { api } from './lib/api';
import { uiLocale, uiTheme } from './ui/theme';

const route = useRoute();
const mode = ref('');
const online = ref(false);
const collapsed = ref(false);
const selectedKeys = computed(() => [route.path === '/history' ? 'history' : 'workers']);
onMounted(async () => {
  try {
    const health = await api<{ mode: string }>('/health');
    mode.value = health.mode;
    online.value = true;
  } catch {
    online.value = false;
  }
});
</script>
<template>
  <ConfigProvider :locale="uiLocale" :theme="uiTheme">
    <Layout class="app-shell">
      <LayoutSider
        v-model:collapsed="collapsed"
        :width="200"
        :collapsed-width="76"
        breakpoint="lg"
        :trigger="null"
        class="sidebar"
      >
        <RouterLink to="/" class="brand"
          ><Avatar :size="38" shape="square" class="brand-mark">W</Avatar
          ><span v-if="!collapsed">数字人<small>WORKSPACE</small></span></RouterLink
        >
        <div class="nav-label">{{ collapsed ? '空间' : '工作空间' }}</div>
        <nav aria-label="主导航">
          <Menu theme="dark" mode="inline" :selected-keys="selectedKeys">
            <MenuItem key="workers"
              ><template #icon><TeamOutlined aria-hidden="true" /></template
              ><RouterLink to="/">数字人</RouterLink></MenuItem
            >
            <MenuItem key="history"
              ><template #icon><HistoryOutlined aria-hidden="true" /></template
              ><RouterLink to="/history">执行记录</RouterLink></MenuItem
            >
          </Menu>
        </nav>
        <div v-if="!collapsed" class="sidebar-bottom">
          <div class="local-card">
            <Badge :status="online ? 'success' : 'warning'" />
            <div>
              {{ online ? '本地服务已连接' : '服务未连接'
              }}<small>{{ mode === 'demo' ? '演示环境 · 无模型调用' : '本地工作空间' }}</small>
            </div>
          </div>
          <div class="sidebar-version">DIGITAL WORKER <span>v0.1</span></div>
        </div>
      </LayoutSider>
      <Layout class="main-shell">
        <LayoutHeader class="topbar">
          <Breadcrumb
            ><BreadcrumbItem>工作空间</BreadcrumbItem
            ><BreadcrumbItem>{{
              route.path === '/history' ? '执行记录' : '数字人'
            }}</BreadcrumbItem></Breadcrumb
          >
          <nav class="mobile-navigation" aria-label="移动导航">
            <Menu mode="horizontal" :selected-keys="selectedKeys">
              <MenuItem key="workers"><RouterLink to="/">数字人</RouterLink></MenuItem>
              <MenuItem key="history"><RouterLink to="/history">执行记录</RouterLink></MenuItem>
            </Menu>
          </nav>
          <Tag class="local-badge">LOCAL</Tag>
        </LayoutHeader>
        <LayoutContent class="page-content"><RouterView /></LayoutContent>
      </Layout>
    </Layout>
  </ConfigProvider>
</template>
