<script setup lang="ts">
import { computed, ref } from 'vue';
import { Alert, Avatar, Button, Empty, List, ListItem, Space, Spin, Tag } from 'ant-design-vue';
import {
  AuditOutlined,
  CopyOutlined,
  DownloadOutlined,
  FileTextOutlined,
} from '@ant-design/icons-vue';
import { isTerminal, type TaskDto, type RunEvent } from '@digital-worker/contracts';
import { api, dateTime, describeError, statusLabels, statusColors } from '../../lib/api';
import { renderMarkdown } from '../../lib/markdown';

const props = defineProps<{
  task: TaskDto;
  workerName: string;
  text?: string;
  events?: RunEvent[];
}>();
const active = computed(() => !isTerminal(props.task.run.status));
const output = computed(() => props.task.run.output ?? props.text ?? '');
const rendered = computed(() => renderMarkdown(output.value));
const traceOpen = ref(false);
const traceError = ref('');
const calls = ref<Array<{ callId: string; toolId: string; status: string; durationMs: number }>>(
  [],
);
const copied = ref(false);
const timeline = computed(
  () => props.events?.filter((event) => event.type !== 'output.delta') ?? [],
);
async function toggleTrace() {
  traceOpen.value = !traceOpen.value;
  if (!traceOpen.value || props.events?.length) return;
  try {
    calls.value = (
      await api<{ toolCalls: typeof calls.value }>(`/runs/${props.task.run.id}`)
    ).toolCalls;
  } catch (error) {
    traceError.value = describeError(error);
  }
}
function label(event: RunEvent) {
  switch (event.type) {
    case 'run.queued':
      return '会话消息已提交';
    case 'run.started':
      return '数字人开始回复';
    case 'tool.started':
      return `调用 ${event.payload.toolId}`;
    case 'tool.completed':
      return `${event.payload.toolId} 已完成`;
    case 'tool.denied':
      return `${event.payload.toolId} 权限被拒绝`;
    case 'tool.failed':
      return `${event.payload.toolId} 执行失败`;
    case 'usage.updated':
      return '模型用量已更新';
    case 'run.completed':
      return '回复完成，内容已保存';
    case 'run.failed':
      return event.payload.message;
    case 'run.cancelled':
      return '本次回复已停止';
    default:
      return '';
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(output.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    traceError.value = '复制失败，请手动选择文本复制';
  }
}
function download() {
  const url = URL.createObjectURL(
    new Blob([output.value], { type: 'text/markdown;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${props.workerName}-回复.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <article class="conversation-turn" :data-task-id="task.id">
    <section class="user-message" aria-label="我的消息">
      <div class="message-caption">
        <span>你</span><time>{{ dateTime(task.createdAt) }}</time>
      </div>
      <div class="user-bubble">{{ task.input }}</div>
      <Tag v-if="task.upload" class="message-attachment"
        ><FileTextOutlined aria-hidden="true" /> {{ task.upload.name }}</Tag
      >
    </section>
    <section class="assistant-message" :aria-label="workerName + '的回复'">
      <Avatar :size="30" shape="square" class="directory-avatar assistant-avatar">{{
        workerName.slice(0, 1)
      }}</Avatar>
      <div class="assistant-content">
        <div class="message-caption">
          <strong>{{ workerName }}</strong
          ><Tag :color="statusColors[task.run.status]" class="status-pill">{{
            statusLabels[task.run.status]
          }}</Tag>
        </div>
        <div v-if="output" class="markdown" v-html="rendered"></div>
        <div v-else-if="active" class="thinking-state">
          <Spin size="small" /><span>{{
            task.run.status === 'queued' ? '正在等待执行…' : '正在思考和处理你的消息…'
          }}</span>
        </div>
        <p v-else-if="!task.run.error" class="message-muted">
          {{
            task.run.status === 'cancelled'
              ? '本次回复已停止，可以继续发送消息。'
              : '本次没有生成回复。'
          }}
        </p>
        <Alert
          v-if="task.run.error"
          type="error"
          show-icon
          :message="task.run.error.message"
          :description="task.run.error.code"
        />
        <div class="message-actions">
          <Space :size="0" wrap>
            <Button type="text" size="small" :aria-expanded="traceOpen" @click="toggleTrace"
              ><template #icon><AuditOutlined aria-hidden="true" /></template
              >{{ traceOpen ? '收起执行过程' : '查看执行过程' }}</Button
            >
            <template v-if="output"
              ><Button type="text" size="small" @click="copy"
                ><template #icon><CopyOutlined aria-hidden="true" /></template
                >{{ copied ? '已复制' : '复制' }}</Button
              ><Button type="text" size="small" @click="download"
                ><template #icon><DownloadOutlined aria-hidden="true" /></template>下载</Button
              ></template
            > </Space
          ><span v-if="task.run.usage.inputTokens !== null" class="message-usage"
            >{{
              (task.run.usage.inputTokens + (task.run.usage.outputTokens ?? 0)).toLocaleString()
            }}
            tokens</span
          >
        </div>
        <div v-if="traceOpen" class="chat-trace">
          <List v-if="timeline.length" size="small" :data-source="timeline"
            ><template #renderItem="{ item }"
              ><ListItem
                ><span>{{ label(item) }}</span
                ><time>{{
                  new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour12: false })
                }}</time></ListItem
              ></template
            ></List
          >
          <List v-else-if="calls.length" size="small" :data-source="calls"
            ><template #renderItem="{ item }"
              ><ListItem
                ><span
                  >{{ item.toolId }}
                  {{
                    item.status === 'completed'
                      ? '已完成'
                      : item.status === 'denied'
                        ? '权限被拒绝'
                        : '执行失败'
                  }}</span
                ><small>{{ item.durationMs }} ms</small></ListItem
              ></template
            ></List
          >
          <Empty
            v-else
            :image="Empty.PRESENTED_IMAGE_SIMPLE"
            :description="traceError || (active ? '等待执行事件…' : '本次未调用工具')"
          />
        </div>
      </div>
    </section>
  </article>
</template>
