<script setup lang="ts">
import { onMounted, ref, onUnmounted } from 'vue';
import { Alert, Badge, Button, Card, Empty, Pagination, Table, Tag } from 'ant-design-vue';
import { ReloadOutlined } from '@ant-design/icons-vue';
import type { TaskDto } from '@digital-worker/contracts';
import { api, dateTime, describeError, statusLabels, statusColors } from '../lib/api';
const items = ref<TaskDto[]>([]);
const total = ref(0);
const current = ref(1);
const error = ref('');
const loading = ref(true);
const columns = [
  { title: '任务文档 / 消息', key: 'task', width: 360 },
  { title: '执行数字人', dataIndex: 'workerName', key: 'workerName', width: 160 },
  { title: '状态', key: 'status', width: 130 },
  { title: '创建时间', key: 'createdAt', width: 160 },
  { title: '', key: 'action', width: 110 },
];
async function load() {
  try {
    const result = await api<{ items: TaskDto[]; total: number }>(
      '/tasks?limit=10&offset=' + (current.value - 1) * 10,
    );
    items.value = result.items;
    total.value = result.total;
    error.value = '';
  } catch (e) {
    error.value = describeError(e);
  } finally {
    loading.value = false;
  }
}
function page(value: number) {
  current.value = value;
  void load();
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(() => {
    void load();
  }, 3000);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <section class="page-heading">
    <div>
      <div class="eyebrow">TASK HISTORY</div>
      <h1>每次执行，都有记录</h1>
      <p>查看数字人处理过的任务，回溯过程与结果。</p>
    </div>
    <Button type="primary" @click="$router.push('/')">选择数字人</Button>
  </section>
  <Alert v-if="error" type="error" show-icon :message="error" class="page-alert" />
  <Card class="history-card">
    <template #title
      ><span>全部任务 <Badge :count="total" :show-zero="true" color="#8b9bb8" /></span
    ></template>
    <template #extra
      ><Button type="text" @click="load"
        ><template #icon><ReloadOutlined aria-hidden="true" /></template>刷新记录</Button
      ></template
    >
    <Table
      :columns="columns"
      :data-source="items"
      row-key="id"
      :pagination="false"
      :loading="loading"
      :scroll="{ x: 850 }"
    >
      <template #emptyText
        ><Empty description="还没有执行记录"
          ><Button @click="$router.push('/')">开启会话</Button></Empty
        ></template
      >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'task'"
          ><RouterLink :to="'/tasks/' + record.id" class="task-link">{{
            record.upload?.name || record.input.slice(0, 32)
          }}</RouterLink>
          <div class="table-input">{{ record.input }}</div></template
        >
        <Tag
          v-else-if="column.key === 'status'"
          :color="statusColors[(record as TaskDto).run.status]"
          >{{ statusLabels[(record as TaskDto).run.status] }}</Tag
        >
        <template v-else-if="column.key === 'createdAt'">{{ dateTime(record.createdAt) }}</template>
        <RouterLink v-else-if="column.key === 'action'" :to="'/tasks/' + record.id"
          >查看详情</RouterLink
        >
      </template>
    </Table>
    <Pagination
      v-if="total > 10"
      :current="current"
      :total="total"
      :page-size="10"
      :show-size-changer="false"
      :show-total="(value) => '共 ' + value + ' 条'"
      class="history-pagination"
      @change="page"
    />
  </Card>
</template>
