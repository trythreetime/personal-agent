<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import {
  Alert,
  Avatar,
  Button,
  Drawer,
  Grid,
  Space,
  Spin,
  Tag,
  Textarea,
  TypographyTitle,
  Upload,
} from 'ant-design-vue';
import type { UploadProps } from 'ant-design-vue';
import {
  CloseOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  MenuOutlined,
  PaperClipOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons-vue';
import type { SessionDto, TaskDto, UploadDto, WorkerDto } from '@digital-worker/contracts';
import { isTerminal } from '@digital-worker/contracts';
import { api, dateTime, describeError, statusLabels } from '../../lib/api';
import { useRun } from '../tasks/useRun';
import ConversationTurn from './ConversationTurn.vue';
import SessionSidebar from './SessionSidebar.vue';
import WorkerDetails from './WorkerDetails.vue';

const props = defineProps<{ worker: WorkerDto; sessionId?: string; focusTaskId?: string }>();
const emit = defineEmits<{ close: []; session: [id: string | null] }>();
const conversation = ref<HTMLElement | null>(null);
const composer = ref<{ focus: () => void } | null>(null);
const closeButton = ref<{ focus: () => void } | null>(null);
const screens = Grid.useBreakpoint();
const mobile = computed(() => !screens.value.md);
const sessions = ref<SessionDto[]>([]);
const sessionTotal = ref(0);
const selectedId = ref<string | null>(props.sessionId ?? null);
const turns = ref<TaskDto[]>([]);
const taskTotal = ref(0);
const loading = ref(false);
const listLoading = ref(true);
const submitting = ref(false);
const detailsOpen = ref(false);
const sidebarOpen = ref(false);
const input = ref('');
const file = ref<File | null>(null);
const formError = ref('');
const listError = ref('');
const { task, events, text, connection, error, load, cancel, stop } = useRun();
const active = computed(() => Boolean(task.value && !isTerminal(task.value.run.status)));
const visibleTurns = computed(() =>
  turns.value.map((turn) => (turn.id === task.value?.id ? task.value : turn)),
);
const selected = computed(() => sessions.value.find((session) => session.id === selectedId.value));
const contextualFile = computed(
  () => [...turns.value].reverse().find((turn) => turn.upload)?.upload ?? null,
);
let upload: UploadDto | null = null;
let key = crypto.randomUUID();
let generation = 0;
let polling: ReturnType<typeof setInterval>;
let listRequest = false;
let disposed = false;
function focusInput() {
  if (disposed || detailsOpen.value) return;
  if (active.value || loading.value || !props.worker.ready) closeButton.value?.focus();
  else composer.value?.focus();
}
async function refreshSessions(more = false) {
  if (listRequest) return;
  listRequest = true;
  try {
    const result = await api<{ items: SessionDto[]; total: number }>(
      `/sessions?workerId=${encodeURIComponent(props.worker.id)}&limit=20&offset=${more ? sessions.value.length : 0}`,
    );
    const fetched = new Set(result.items.map((session) => session.id));
    sessions.value = more
      ? [
          ...sessions.value,
          ...result.items.filter(
            (session) => !sessions.value.some((existing) => existing.id === session.id),
          ),
        ]
      : [...result.items, ...sessions.value.filter((session) => !fetched.has(session.id))];
    sessionTotal.value = result.total;
    listError.value = '';
  } catch (e) {
    listError.value = describeError(e);
  } finally {
    listLoading.value = false;
    listRequest = false;
  }
}
function clearRun() {
  stop();
  task.value = null;
  events.value = [];
  text.value = '';
  error.value = '';
}
async function chooseSession(id: string | null, notify = true) {
  if (submitting.value) return;
  const current = ++generation;
  selectedId.value = id;
  sidebarOpen.value = false;
  clearRun();
  turns.value = [];
  taskTotal.value = 0;
  formError.value = '';
  input.value = '';
  file.value = null;
  upload = null;
  key = crypto.randomUUID();
  if (notify) emit('session', id);
  if (!id) {
    loading.value = false;
    await nextTick();
    focusInput();
    return;
  }
  loading.value = true;
  try {
    const session = await api<SessionDto>(`/sessions/${id}`);
    if (current !== generation) return;
    if (session.workerId !== props.worker.id) {
      formError.value = '该会话不属于当前数字人';
      return;
    }
    const result = await api<{ items: TaskDto[]; total: number }>(
      `/tasks?workerId=${encodeURIComponent(props.worker.id)}&sessionId=${id}&limit=20`,
    );
    if (current !== generation) return;
    turns.value = result.items.reverse();
    taskTotal.value = result.total;
    const latest = turns.value.at(-1);
    if (latest) await load(latest.id);
    if (current !== generation) return;
    await scrollToConversation();
  } catch (e) {
    if (current === generation) formError.value = describeError(e);
  } finally {
    if (current === generation) {
      loading.value = false;
      await nextTick();
      focusInput();
    }
  }
}
async function olderMessages() {
  if (!selectedId.value || loading.value) return;
  const id = selectedId.value;
  const current = generation;
  const oldHeight = conversation.value?.scrollHeight ?? 0;
  loading.value = true;
  try {
    const result = await api<{ items: TaskDto[]; total: number }>(
      `/tasks?workerId=${encodeURIComponent(props.worker.id)}&sessionId=${id}&limit=20&offset=${turns.value.length}`,
    );
    if (current !== generation) return;
    turns.value = [...result.items.reverse(), ...turns.value];
    taskTotal.value = result.total;
    await nextTick();
    if (conversation.value)
      conversation.value.scrollTop += conversation.value.scrollHeight - oldHeight;
  } catch (e) {
    if (current === generation) formError.value = describeError(e);
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function scrollToConversation() {
  await nextTick();
  if (props.focusTaskId) {
    conversation.value
      ?.querySelector(`[data-task-id="${props.focusTaskId}"]`)
      ?.scrollIntoView({ block: 'start' });
  } else if (conversation.value) conversation.value.scrollTop = conversation.value.scrollHeight;
}
watch(text, async () => {
  const element = conversation.value;
  if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 160) {
    await nextTick();
    element.scrollTop = element.scrollHeight;
  }
});
watch(
  () => task.value?.run.status,
  (status) => {
    if (status && isTerminal(status)) {
      if (task.value)
        turns.value = turns.value.map((turn) => (turn.id === task.value!.id ? task.value! : turn));
      void refreshSessions();
    }
  },
);
watch(
  () => props.sessionId,
  (id) => {
    if ((id ?? null) !== selectedId.value) void chooseSession(id ?? null, false);
  },
);
watch(input, () => {
  key = crypto.randomUUID();
});
function chooseFile(value?: File) {
  if (!value) return;
  if (!/\.(md|txt)$/i.test(value.name) || !value.size || value.size > 2_097_152) {
    formError.value = '请选择不超过 2 MiB 的非空 Markdown 或 TXT 文件';
    return;
  }
  file.value = value;
  upload = null;
  key = crypto.randomUUID();
  formError.value = '';
}
const beforeUpload: UploadProps['beforeUpload'] = (value) => {
  chooseFile(value);
  return false;
};
function removeFile() {
  file.value = null;
  upload = null;
  key = crypto.randomUUID();
}
function sample() {
  chooseFile(
    new File(
      [
        '# 读书清单工具需求\n\n记录书名、作者和阅读状态，支持添加、编辑、删除与筛选，刷新后保留记录。\n\n首版通过网页操作，不需要账号或多人协作。',
      ],
      '示例需求.md',
      { type: 'text/markdown' },
    ),
  );
  input.value = '请分析这份文档，梳理核心功能、开发任务、验收标准和待确认问题。';
}
async function send() {
  if (
    !input.value.trim() ||
    submitting.value ||
    active.value ||
    loading.value ||
    !props.worker.ready
  )
    return;
  submitting.value = true;
  formError.value = '';
  try {
    if (file.value && !upload) {
      const body = new FormData();
      body.append('file', file.value);
      upload = await api<UploadDto>('/uploads', { method: 'POST', body });
    }
    const value = await api<TaskDto>('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        workerId: props.worker.id,
        input: input.value,
        ...(selectedId.value ? { sessionId: selectedId.value } : {}),
        ...(upload ? { uploadId: upload.id } : {}),
      }),
    });
    if (disposed) return;
    selectedId.value = value.sessionId;
    emit('session', value.sessionId);
    turns.value.push(value);
    taskTotal.value++;
    input.value = '';
    file.value = null;
    upload = null;
    key = crypto.randomUUID();
    await load(value.id);
    await refreshSessions();
    await scrollToConversation();
  } catch (e) {
    formError.value = describeError(e);
  } finally {
    submitting.value = false;
    await nextTick();
    focusInput();
  }
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}
onMounted(async () => {
  await refreshSessions();
  if (disposed) return;
  await chooseSession(props.sessionId ?? sessions.value[0]?.id ?? null, !props.sessionId);
  if (disposed) return;
  polling = setInterval(() => {
    void refreshSessions();
  }, 3000);
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearInterval(polling);
});
</script>

<template>
  <Drawer
    :open="true"
    :closable="false"
    :keyboard="!sidebarOpen && !detailsOpen"
    :push="false"
    placement="right"
    destroy-on-close
    :width="mobile ? '100%' : 'min(1180px, 94vw)'"
    root-class-name="worker-drawer"
    @close="emit('close')"
  >
    <section
      class="worker-drawer-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worker-dialog-title"
    >
      <header class="worker-dialog-header">
        <div class="dialog-identity">
          <Avatar :size="36" shape="square" class="directory-avatar">{{
            worker.name.slice(0, 1)
          }}</Avatar>
          <div>
            <TypographyTitle :level="5" id="worker-dialog-title">{{ worker.name }}</TypographyTitle>
            <div class="identity-subtitle">
              {{ worker.role }} · {{ worker.mode === 'demo' ? '本地演示' : worker.modelName }}
            </div>
          </div>
        </div>
        <Space :size="8"
          ><Button type="text" aria-haspopup="dialog" @click="detailsOpen = true"
            ><template #icon><InfoCircleOutlined aria-hidden="true" /></template>数字人详情</Button
          ><Button
            ref="closeButton"
            type="text"
            shape="circle"
            aria-label="关闭对话"
            @click="emit('close')"
            ><template #icon><CloseOutlined aria-hidden="true" /></template></Button
        ></Space>
      </header>
      <div class="worker-drawer-body" :class="{ 'is-mobile': mobile }">
        <SessionSidebar
          v-if="!mobile"
          :sessions="sessions"
          :selected-id="selectedId"
          :total="sessionTotal"
          :loading="listLoading"
          :busy="submitting || loading"
          :error="listError"
          @select="chooseSession"
          @more="refreshSessions(true)"
          @retry="refreshSessions()"
        />
        <Drawer
          v-if="mobile"
          :open="sidebarOpen"
          placement="left"
          :width="270"
          :get-container="false"
          :root-style="{ position: 'absolute' }"
          root-class-name="sessions-drawer"
          :body-style="{ padding: 0 }"
          :push="false"
          title="会话列表"
          @close="sidebarOpen = false"
        >
          <div class="session-drawer-panel" role="dialog" aria-modal="true" aria-label="会话列表">
            <SessionSidebar
              :sessions="sessions"
              :selected-id="selectedId"
              :total="sessionTotal"
              :loading="listLoading"
              :busy="submitting || loading"
              :error="listError"
              @select="chooseSession"
              @more="refreshSessions(true)"
              @retry="refreshSessions()"
            />
          </div>
        </Drawer>
        <section class="chat-workspace" aria-label="会话内容">
          <header class="chat-heading">
            <Button v-if="mobile" type="text" aria-label="打开会话列表" @click="sidebarOpen = true"
              ><template #icon><MenuOutlined aria-hidden="true" /></template
            ></Button>
            <div>
              <h3>{{ selected?.title || (selectedId ? '会话' : '新会话') }}</h3>
              <span>{{
                active ? '正在回复' : selectedId ? '内容自动保存' : '开始与数字人交流'
              }}</span>
            </div>
            <Tag v-if="worker.mode === 'demo'">演示模式</Tag>
          </header>
          <Alert
            v-if="worker.mode === 'demo'"
            type="info"
            banner
            message="本地固定流程演示，不调用真实模型。"
            class="chat-demo-notice"
          />
          <div ref="conversation" class="conversation-scroll" aria-label="对话消息">
            <Button
              v-if="turns.length < taskTotal"
              type="link"
              block
              :loading="loading"
              @click="olderMessages"
              >加载更早的消息</Button
            >
            <div v-if="loading && !turns.length" class="conversation-loading">
              <Spin tip="正在读取会话…" />
            </div>
            <div v-else-if="!turns.length" class="chat-welcome">
              <Avatar :size="64" shape="square" class="directory-avatar">{{
                worker.name.slice(0, 1)
              }}</Avatar
              ><TypographyTitle :level="4">你好，我是{{ worker.name }}</TypographyTitle>
              <p>{{ worker.description }}</p>
              <Space wrap :size="[4, 8]"
                ><Tag v-for="skill in worker.skills" :key="skill.id" color="blue">{{
                  skill.name
                }}</Tag></Space
              ><Button @click="sample">从一份示例需求开始</Button>
            </div>
            <ConversationTurn
              v-for="turn in visibleTurns"
              :key="turn.id"
              :task="turn"
              :worker-name="worker.name"
              :text="turn.id === task?.id ? text : undefined"
              :events="turn.id === task?.id ? events : undefined"
            />
          </div>
          <Alert
            v-if="error || formError"
            type="error"
            show-icon
            :message="formError || error"
            class="chat-error"
          />
          <Alert
            v-if="!worker.ready"
            type="warning"
            show-icon
            :message="worker.unavailableReason || '数字人暂不可用'"
            class="chat-error"
          />
          <form class="chat-composer" @submit.prevent="send">
            <Tag v-if="file" color="blue" class="composer-attachment"
              ><FileTextOutlined aria-hidden="true" /> {{ file.name
              }}<Button
                type="text"
                size="small"
                aria-label="移除附件"
                :disabled="submitting"
                @click="removeFile"
                ><template #icon><CloseOutlined aria-hidden="true" /></template></Button
            ></Tag>
            <div v-else-if="contextualFile" class="contextual-file">
              <FileTextOutlined aria-hidden="true" /> 本会话文档：{{ contextualFile.name }}
            </div>
            <label for="chat-message" class="visually-hidden">消息内容</label>
            <Textarea
              id="chat-message"
              ref="composer"
              v-model:value="input"
              :bordered="false"
              :auto-size="{ minRows: 1, maxRows: 5 }"
              placeholder="输入消息，或上传一份文档开始交流…"
              :maxlength="10000"
              :disabled="submitting || active || !worker.ready || loading"
              @keydown="keyboard"
            />
            <div class="composer-toolbar">
              <Space :size="4">
                <Upload
                  data-testid="document-upload"
                  accept=".md,.txt"
                  :before-upload="beforeUpload"
                  :show-upload-list="false"
                  :max-count="1"
                  :disabled="submitting || active || loading || !worker.ready"
                  ><Button type="text" :disabled="submitting || active || loading || !worker.ready"
                    ><template #icon><PaperClipOutlined aria-hidden="true" /></template
                    >上传文档</Button
                  ></Upload
                >
                <Button
                  v-if="!selectedId"
                  type="text"
                  :disabled="submitting || active"
                  @click="sample"
                  >使用示例</Button
                > </Space
              ><Button v-if="active" @click="cancel"
                ><template #icon><StopOutlined aria-hidden="true" /></template>停止生成</Button
              ><Button
                v-else
                type="primary"
                html-type="submit"
                :loading="submitting"
                :disabled="!input.trim() || submitting || loading || !worker.ready"
                ><template #icon><SendOutlined aria-hidden="true" /></template
                >{{ submitting ? '发送中…' : '发送消息' }}</Button
              >
            </div>
            <div class="composer-footnote">
              {{
                connection === 'reconnecting'
                  ? '连接恢复中，已保存内容会自动补读'
                  : 'Enter 发送 · Shift + Enter 换行'
              }}
            </div>
          </form>
        </section>
      </div>
    </section>
  </Drawer>
  <WorkerDetails :worker="worker" :open="detailsOpen" @close="detailsOpen = false" />
</template>
