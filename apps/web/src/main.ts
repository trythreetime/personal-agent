import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import 'ant-design-vue/dist/reset.css';
import './style.css';
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/Workers.vue') },
    { path: '/tasks/:id', component: () => import('./pages/Workers.vue') },
    { path: '/history', component: () => import('./pages/History.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
createApp(App).use(router).mount('#app');
