<script setup lang="ts">
import { Alert, Button, Empty, List, ListItem, Spin, TypographyText } from 'ant-design-vue';
import { PlusOutlined } from '@ant-design/icons-vue';
import type { SessionDto } from '@digital-worker/contracts';
import { dateTime, statusLabels } from '../../lib/api';
defineProps<{
  sessions: SessionDto[];
  selectedId: string | null;
  total: number;
  loading: boolean;
  busy: boolean;
  error: string;
}>();
const emit = defineEmits<{ select: [id: string | null]; more: []; retry: [] }>();
</script>
<template>
  <aside class="session-sidebar" aria-label="当前数字人的会话">
    <Button
      type="primary"
      ghost
      block
      aria-label="新建会话"
      :disabled="busy || loading"
      @click="emit('select', null)"
      ><template #icon><PlusOutlined aria-hidden="true" /></template>新建会话</Button
    >
    <div class="session-list-heading">
      <TypographyText type="secondary">历史会话</TypographyText
      ><TypographyText type="secondary">{{ total }}</TypographyText>
    </div>
    <Alert v-if="error" type="error" :message="error" show-icon
      ><template #action><Button size="small" @click="emit('retry')">重试</Button></template></Alert
    >
    <div class="session-list">
      <Spin v-if="loading && !sessions.length" class="session-spinner" />
      <Empty
        v-else-if="!sessions.length"
        :image="Empty.PRESENTED_IMAGE_SIMPLE"
        description="还没有会话，发送消息开始交流。"
      />
      <List v-else :data-source="sessions" row-key="id" :split="false">
        <template #renderItem="{ item }"
          ><ListItem class="session-list-row"
            ><Button
              type="text"
              block
              class="session-item"
              :class="{ selected: selectedId === item.id }"
              :data-session-id="item.id"
              :aria-current="selectedId === item.id ? 'true' : undefined"
              :disabled="busy"
              @click="emit('select', item.id)"
              ><span class="session-title">{{ item.title }}</span
              ><span class="session-item-meta"
                ><time>{{ dateTime(item.updatedAt) }}</time
                ><span>{{
                  item.lastStatus === 'running' || item.lastStatus === 'queued'
                    ? statusLabels[item.lastStatus as keyof typeof statusLabels]
                    : item.taskCount + ' 轮对话'
                }}</span></span
              ></Button
            ></ListItem
          ></template
        >
      </List>
      <Button v-if="sessions.length < total" type="link" block @click="emit('more')"
        >加载更多会话</Button
      >
    </div>
    <div class="session-sidebar-footer">会话与当前数字人独立关联</div>
  </aside>
</template>
