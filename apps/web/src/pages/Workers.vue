<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  InputSearch,
  Row,
  Spin,
  Tag,
  TypographyTitle,
} from 'ant-design-vue';
import { MessageOutlined } from '@ant-design/icons-vue';
import type { TaskDto, WorkerDto } from '@digital-worker/contracts';
import { api, describeError } from '../lib/api';
import WorkerDialog from '../features/workers/WorkerDialog.vue';

const route = useRoute();
const router = useRouter();
const workers = ref<WorkerDto[]>([]);
const search = ref('');
const loading = ref(true);
const error = ref('');
const filtered = computed(() =>
  workers.value.filter((worker) =>
    (worker.name + ' ' + worker.role + ' ' + worker.description)
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
const selected = computed(() => workers.value.find((worker) => worker.id === route.query.worker));
const sessionId = computed(() =>
  typeof route.query.session === 'string' ? route.query.session : undefined,
);
async function loadWorkers() {
  loading.value = true;
  error.value = '';
  try {
    workers.value = (await api<{ items: WorkerDto[] }>('/workers')).items;
  } catch (e) {
    error.value = describeError(e);
  } finally {
    loading.value = false;
  }
}
async function legacyTask(id: string) {
  try {
    const task = await api<TaskDto>('/tasks/' + id);
    await router.replace({
      path: '/',
      query: { worker: task.workerId, session: task.sessionId, task: task.id },
    });
  } catch (e) {
    error.value = describeError(e);
  }
}
onMounted(async () => {
  await loadWorkers();
  if (typeof route.params.id === 'string') await legacyTask(route.params.id);
});
watch(
  () => route.params.id,
  (id) => {
    if (typeof id === 'string') void legacyTask(id);
  },
);
function open(worker: WorkerDto) {
  void router.push({ path: '/', query: { worker: worker.id } });
}
function close() {
  void router.replace({ path: '/', query: {} });
}
function changeSession(id: string | null) {
  if (!selected.value) return;
  void router.replace({
    path: '/',
    query: { worker: selected.value.id, ...(id ? { session: id } : {}) },
  });
}
</script>
<template>
  <section class="page-heading">
    <div>
      <div class="eyebrow">YOUR DIGITAL TEAM</div>
      <h1>我的数字人</h1>
      <p>选择一位数字人，开启会话，或继续之前的工作。</p>
    </div>
    <Tag class="worker-total">{{ workers.length }} 位数字人</Tag>
  </section>
  <section class="worker-directory">
    <div class="worker-directory-toolbar">
      <h2>全部数字人 <Badge :count="workers.length" :show-zero="true" color="#8b9bb8" /></h2>
      <InputSearch
        v-model:value="search"
        allow-clear
        aria-label="搜索数字人"
        placeholder="搜索数字人或岗位"
        class="worker-search"
      />
    </div>
    <Alert v-if="error" type="error" show-icon :message="error"
      ><template #action
        ><Button size="small" @click="loadWorkers">重新加载</Button></template
      ></Alert
    >
    <div v-if="loading" class="directory-empty"><Spin tip="正在加载数字人…" /></div>
    <Empty
      v-else-if="!filtered.length"
      :description="search ? '没有找到匹配的数字人' : '暂时没有数字人'"
      class="directory-empty"
    />
    <Row v-else :gutter="[16, 16]">
      <Col v-for="worker in filtered" :key="worker.id" :xs="24" :sm="12" :xl="8" :xxl="6">
        <Card
          hoverable
          class="worker-card"
          role="button"
          tabindex="0"
          :aria-label="'打开' + worker.name + '的会话'"
          @click="open(worker)"
          @keydown.enter="open(worker)"
          @keydown.space.prevent="open(worker)"
        >
          <div class="worker-card-top">
            <Avatar :size="56" shape="square" class="directory-avatar">{{
              worker.name.slice(0, 1)
            }}</Avatar
            ><Badge
              :status="worker.ready ? 'success' : 'default'"
              :text="worker.status === 'disabled' ? '已停用' : worker.ready ? '可用' : '待配置'"
            />
          </div>
          <TypographyTitle :level="4" class="worker-name">{{ worker.name }}</TypographyTitle>
          <div class="worker-role">{{ worker.role }}</div>
          <p class="directory-description">{{ worker.description }}</p>
          <div class="directory-skill-tags">
            <Tag v-for="skill in worker.skills" :key="skill.id">{{ skill.name }}</Tag
            ><Tag v-if="!worker.skills.length">通用能力</Tag>
          </div>
          <div class="worker-card-footer">
            <span>{{ worker.mode === 'demo' ? '本地演示' : worker.modelName }}</span
            ><span class="card-conversation-action"
              ><MessageOutlined aria-hidden="true" /> 进入会话</span
            >
          </div>
        </Card>
      </Col>
    </Row>
    <p class="directory-footnote">每位数字人拥有独立的会话，历史消息会自动保存。</p>
  </section>
  <WorkerDialog
    v-if="selected"
    :key="selected.id"
    :worker="selected"
    :session-id="sessionId"
    :focus-task-id="typeof route.query.task === 'string' ? route.query.task : undefined"
    @close="close"
    @session="changeSession"
  />
</template>
