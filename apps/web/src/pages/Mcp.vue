<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  Alert,
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  FormItem,
  Input,
  InputNumber,
  InputPassword,
  Modal,
  Popconfirm,
  RadioGroup,
  RadioButton,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Textarea,
} from 'ant-design-vue';
import { ApiOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import {
  mcpWriteSchema,
  type McpListDto,
  type McpServerDto,
  type McpToolInfo,
  type McpWrite,
  type WorkerDto,
} from '@digital-worker/contracts';
import { api, describeError } from '../lib/api';

const data = ref<McpListDto>({ revision: 0, items: [] });
const workers = ref<WorkerDto[]>([]);
const loading = ref(true);
const error = ref('');
const search = ref('');
const open = ref(false);
const editing = ref<string | null>(null);
const saving = ref(false);
const probing = ref(false);
const busy = ref('');
const formError = ref('');
const probeResult = ref('');
const discovered = ref<McpToolInfo[]>([]);
const details = ref<McpServerDto | null>(null);
const form = ref({
  id: '',
  name: '',
  transport: 'stdio' as 'stdio' | 'streamable-http',
  enabled: true,
  command: 'node',
  args: '',
  envRefs: '{}',
  url: '',
  bearerTokenRef: '',
  bearerToken: '',
  clearBearerToken: false,
  hasManagedToken: false,
  timeoutMs: 10000,
  allowedTools: [] as string[],
  workerIds: [] as string[],
});
const columns = [
  { title: '服务', key: 'name', width: 170 },
  { title: '连接', key: 'connection', width: 270 },
  { title: '工具 / 数字人', key: 'bindings', width: 210 },
  { title: '验证状态', key: 'state', width: 120 },
  { title: '启用', key: 'enabled', width: 75 },
  { title: '操作', key: 'actions', width: 190 },
];
const filtered = computed(() =>
  data.value.items.filter((entry) =>
    (entry.name + ' ' + entry.config.id).toLowerCase().includes(search.value.trim().toLowerCase()),
  ),
);
const enabledCount = computed(
  () => data.value.items.filter((entry) => entry.config.enabled).length,
);
const boundCount = computed(
  () => new Set(data.value.items.flatMap((entry) => entry.workerIds)).size,
);
const workerOptions = computed(() =>
  workers.value.map((worker) => ({ value: worker.id, label: worker.name })),
);
const toolOptions = computed(() => {
  const options = discovered.value.map((tool) => ({
    value: tool.name,
    label: tool.name + (!tool.readOnly ? ' · 非只读' : !tool.supported ? ' · Schema 暂不支持' : ''),
    disabled: !tool.readOnly || !tool.supported,
  }));
  for (const name of form.value.allowedTools)
    if (!options.some((option) => option.value === name))
      options.push({ value: name, label: name, disabled: false });
  return options;
});
function workerName(id: string) {
  return workers.value.find((worker) => worker.id === id)?.name ?? id;
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [settings, directory] = await Promise.all([
      api<McpListDto>('/mcp'),
      api<{ items: WorkerDto[] }>('/workers'),
    ]);
    data.value = settings;
    workers.value = directory.items;
  } catch (e) {
    error.value = describeError(e);
  } finally {
    loading.value = false;
  }
}
function edit(entry?: McpServerDto) {
  editing.value = entry?.config.id ?? null;
  const config = entry?.config;
  Object.assign(form.value, {
    id: config?.id ?? '',
    name: entry?.name ?? '',
    transport: config?.transport ?? 'stdio',
    enabled: config?.enabled ?? true,
    timeoutMs: config?.timeoutMs ?? 10000,
    command: config?.transport === 'stdio' ? config.command : 'node',
    args: config?.transport === 'stdio' ? config.args.join('\n') : '',
    envRefs: config?.transport === 'stdio' ? JSON.stringify(config.envRefs, null, 2) : '{}',
    url: config?.transport === 'streamable-http' ? config.url : '',
    bearerTokenRef: config?.transport === 'streamable-http' ? (config.bearerTokenRef ?? '') : '',
    bearerToken: '',
    clearBearerToken: false,
    hasManagedToken: entry?.hasManagedToken ?? false,
    allowedTools: [...(config?.allowedTools ?? [])],
    workerIds: [...(entry?.workerIds ?? [])],
  });
  discovered.value = entry?.tools ?? [];
  formError.value = '';
  probeResult.value = '';
  open.value = true;
}
function close() {
  if (saving.value || probing.value) return;
  open.value = false;
  form.value.bearerToken = '';
}
function useBuiltin() {
  form.value.command = 'node';
  form.value.args = 'mcp-servers/reference/src/index.mjs';
  form.value.transport = 'stdio';
  if (!form.value.name) form.value.name = '资料查询服务';
  probeResult.value = '';
  discovered.value = [];
}
function payload(): McpWrite | undefined {
  formError.value = '';
  if (!form.value.id.trim() || !form.value.name.trim()) {
    formError.value = '请填写服务 ID 和名称';
    return;
  }
  let envRefs: unknown = {};
  if (form.value.transport === 'stdio') {
    try {
      envRefs = JSON.parse(form.value.envRefs || '{}');
    } catch {
      formError.value = '环境变量引用必须是 JSON 对象';
      return;
    }
  }
  const config = {
    id: form.value.id.trim(),
    transport: form.value.transport,
    enabled: form.value.enabled,
    timeoutMs: form.value.timeoutMs,
    allowedTools: form.value.allowedTools,
    ...(form.value.transport === 'stdio'
      ? {
          command: form.value.command.trim(),
          args: form.value.args
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
          envRefs,
        }
      : {
          url: form.value.url.trim(),
          ...(form.value.bearerTokenRef.trim()
            ? { bearerTokenRef: form.value.bearerTokenRef.trim() }
            : {}),
        }),
  };
  const parsed = mcpWriteSchema.safeParse({
    config,
    name: form.value.name.trim(),
    workerIds: form.value.workerIds,
    expectedRevision: data.value.revision,
    ...(form.value.transport === 'streamable-http' && form.value.bearerToken
      ? { bearerToken: form.value.bearerToken }
      : {}),
    ...(form.value.transport === 'streamable-http' && form.value.clearBearerToken
      ? { clearBearerToken: true }
      : {}),
  });
  if (!parsed.success) {
    formError.value =
      '请检查服务 ID、连接地址、超时和凭证引用格式。ID 使用小写字母、数字和连字符；凭证引用为 env:变量名。';
    return;
  }
  return parsed.data;
}
async function probe() {
  const value = payload();
  if (!value) return;
  probing.value = true;
  probeResult.value = '';
  try {
    const { expectedRevision, ...draft } = value;
    const result = await api<{ tools: McpToolInfo[] }>('/mcp/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    discovered.value = result.tools;
    probeResult.value =
      '连接成功，发现 ' + result.tools.length + ' 个工具。请选择允许使用的只读工具。';
  } catch (e) {
    formError.value = describeError(e);
  } finally {
    probing.value = false;
  }
}
async function save() {
  const value = payload();
  if (!value) return;
  if (value.config.enabled && !value.config.allowedTools.length) {
    formError.value = '请先测试连接并选择至少一个只读工具，或将服务设为停用后保存';
    return;
  }
  saving.value = true;
  try {
    data.value = await api<McpListDto>(editing.value ? '/mcp/' + editing.value : '/mcp', {
      method: editing.value ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    form.value.bearerToken = '';
    open.value = false;
  } catch (e) {
    formError.value = describeError(e);
  } finally {
    saving.value = false;
  }
}
async function toggle(entry: McpServerDto, enabled: boolean) {
  busy.value = entry.config.id;
  error.value = '';
  try {
    data.value = await api<McpListDto>('/mcp/' + entry.config.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: { ...entry.config, enabled },
        name: entry.name,
        workerIds: entry.workerIds,
        expectedRevision: data.value.revision,
      }),
    });
  } catch (e) {
    error.value = describeError(e);
  } finally {
    busy.value = '';
  }
}
async function remove(entry: McpServerDto) {
  busy.value = entry.config.id;
  error.value = '';
  try {
    data.value = await api<McpListDto>('/mcp/' + entry.config.id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: data.value.revision }),
    });
  } catch (e) {
    error.value = describeError(e);
  } finally {
    busy.value = '';
  }
}
onMounted(load);
</script>

<template>
  <section class="page-heading">
    <div>
      <div class="eyebrow">CAPABILITIES</div>
      <h1>MCP 管理</h1>
      <p>配置服务连接、选择工具，并绑定到数字人。</p>
    </div>
    <Button type="primary" @click="edit()"
      ><template #icon><PlusOutlined aria-hidden="true" /></template>新增 MCP</Button
    >
  </section>
  <div class="mcp-overview">
    <Card size="small"
      ><span>服务总数</span><strong>{{ data.items.length }}</strong></Card
    >
    <Card size="small"
      ><span>已启用</span><strong>{{ enabledCount }}</strong></Card
    >
    <Card size="small"
      ><span>已绑定数字人</span><strong>{{ boundCount }}</strong></Card
    >
  </div>
  <Alert v-if="error" :message="error" type="error" show-icon class="page-alert" />
  <Card class="mcp-table-card">
    <template #title
      ><Space><ApiOutlined aria-hidden="true" /> MCP 服务</Space></template
    >
    <template #extra
      ><Space
        ><Input
          v-model:value="search"
          aria-label="搜索 MCP 服务"
          placeholder="搜索名称或 ID"
          allow-clear
          class="mcp-search" /><Button
          type="text"
          aria-label="刷新 MCP 列表"
          :loading="loading"
          @click="load"
          ><template #icon><ReloadOutlined aria-hidden="true" /></template></Button></Space
    ></template>
    <Table
      :columns="columns"
      :data-source="filtered"
      :row-key="(entry: McpServerDto) => entry.config.id"
      :loading="loading"
      size="small"
      :scroll="{ x: 1050 }"
      :pagination="{ pageSize: 10, hideOnSinglePage: true }"
    >
      <template #emptyText
        ><Empty description="还没有 MCP 服务，添加连接后即可为数字人提供工具。"
      /></template>
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'"
          ><strong>{{ record.name }}</strong>
          <div class="mcp-secondary">{{ record.config.id }}</div></template
        >
        <template v-else-if="column.key === 'connection'"
          ><Tag>{{ record.config.transport === 'stdio' ? 'Stdio' : 'Streamable HTTP' }}</Tag>
          <div
            class="mcp-endpoint"
            :title="
              record.config.transport === 'stdio'
                ? [record.config.command, ...record.config.args].join(' ')
                : record.config.url
            "
          >
            {{
              record.config.transport === 'stdio'
                ? [record.config.command, ...record.config.args].join(' ')
                : record.config.url
            }}
          </div></template
        >
        <template v-else-if="column.key === 'bindings'"
          ><div class="mcp-secondary">{{ record.config.allowedTools.length }} 个允许的工具</div>
          <Space wrap :size="[0, 4]"
            ><Tag v-for="id in record.workerIds" :key="id">{{ workerName(id) }}</Tag
            ><span v-if="!record.workerIds.length" class="mcp-secondary">未绑定数字人</span></Space
          ></template
        >
        <template v-else-if="column.key === 'state'"
          ><Badge
            :status="
              record.state === 'ready' ? 'success' : record.state === 'error' ? 'error' : 'default'
            "
            :text="
              record.state === 'ready' ? '已验证' : record.state === 'error' ? '连接异常' : '已停用'
            "
          />
          <div v-if="record.error" class="mcp-error-text">{{ record.error.message }}</div></template
        >
        <template v-else-if="column.key === 'enabled'"
          ><Switch
            :checked="record.config.enabled"
            :aria-label="'启用 ' + record.name"
            :loading="busy === record.config.id"
            :disabled="Boolean(busy)"
            @change="(value) => toggle(record as McpServerDto, Boolean(value))"
        /></template>
        <template v-else-if="column.key === 'actions'"
          ><Space :size="0"
            ><Button
              type="link"
              size="small"
              :disabled="Boolean(busy)"
              :aria-label="'编辑 ' + record.name"
              @click="edit(record as McpServerDto)"
              >编辑</Button
            ><Button type="link" size="small" @click="details = record as McpServerDto">工具</Button
            ><Popconfirm
              title="删除这个 MCP 服务？"
              description="将解除数字人绑定；已有任务保留原配置。"
              ok-text="删除"
              cancel-text="取消"
              @confirm="remove(record as McpServerDto)"
              ><Button type="link" danger size="small" :disabled="Boolean(busy)"
                >删除</Button
              ></Popconfirm
            ></Space
          ></template
        >
      </template>
    </Table>
  </Card>
  <p class="mcp-page-note">
    保存后对新任务立即生效。已有任务沿用配置快照，历史会话和调用记录会保留。
  </p>

  <Drawer
    :open="open"
    :title="editing ? '编辑 MCP 服务' : '新增 MCP 服务'"
    width="min(680px, 100vw)"
    :mask-closable="!saving && !probing"
    :keyboard="!saving && !probing"
    :closable="!saving && !probing"
    destroy-on-close
    @close="close"
  >
    <Form layout="vertical" class="mcp-form" @submit.prevent="save">
      <Alert v-if="formError" :message="formError" type="error" show-icon class="page-alert" />
      <Alert
        v-if="probeResult"
        :message="probeResult"
        type="success"
        show-icon
        class="page-alert"
      />
      <div class="mcp-form-grid">
        <FormItem label="服务名称" html-for="mcp-name" required
          ><Input
            id="mcp-name"
            v-model:value="form.name"
            :maxlength="80"
            placeholder="例如：项目资料服务"
        /></FormItem>
        <FormItem label="服务 ID" html-for="mcp-id" required
          ><Input
            id="mcp-id"
            v-model:value="form.id"
            :disabled="Boolean(editing)"
            :maxlength="24"
            placeholder="例如：project-docs"
        /></FormItem>
      </div>
      <FormItem label="连接方式"
        ><RadioGroup v-model:value="form.transport" aria-label="连接方式"
          ><RadioButton value="stdio">Stdio 本地进程</RadioButton
          ><RadioButton value="streamable-http">Streamable HTTP</RadioButton></RadioGroup
        ></FormItem
      >
      <template v-if="form.transport === 'stdio'">
        <FormItem label="启动命令" html-for="mcp-command" required
          ><Input id="mcp-command" v-model:value="form.command" placeholder="例如：node"
        /></FormItem>
        <FormItem
          label="启动参数"
          html-for="mcp-args"
          extra="每行一个参数，无需 Shell 引号；命令在平台项目目录运行。"
          ><Textarea
            id="mcp-args"
            v-model:value="form.args"
            :rows="3"
            placeholder="path/to/server.mjs"
          /><Button type="link" size="small" @click="useBuiltin">填入内置资料服务</Button></FormItem
        >
        <FormItem
          label="环境变量引用"
          html-for="mcp-env"
          extra='JSON 对象，例如 { "SERVICE_TOKEN": "env:MY_TOKEN" }。'
          ><Textarea id="mcp-env" v-model:value="form.envRefs" :rows="2"
        /></FormItem>
      </template>
      <template v-else>
        <FormItem label="服务地址" html-for="mcp-url" required
          ><Input
            id="mcp-url"
            v-model:value="form.url"
            placeholder="https://your-service.example/mcp"
        /></FormItem>
        <FormItem
          label="Bearer 凭证"
          html-for="mcp-token"
          :extra="
            form.hasManagedToken
              ? '已保存凭证；留空保持现有值，接口不会回显密钥。'
              : '可选。保存在本机平台配置中，不会回显。'
          "
          ><InputPassword
            id="mcp-token"
            v-model:value="form.bearerToken"
            autocomplete="new-password"
            :placeholder="form.hasManagedToken ? '已配置，留空不修改' : '填写 Token（可选）'"
          /><Switch
            v-if="form.hasManagedToken"
            v-model:checked="form.clearBearerToken"
            aria-label="清除已保存凭证"
            size="small"
          /><span v-if="form.hasManagedToken" class="mcp-secondary"> 清除已保存凭证</span></FormItem
        >
        <FormItem
          label="环境变量凭证引用"
          html-for="mcp-token-ref"
          extra="也可引用服务端已有变量，例如 env:MCP_DOCS_TOKEN；填写上方凭证时优先使用新值。"
          ><Input
            id="mcp-token-ref"
            v-model:value="form.bearerTokenRef"
            placeholder="env:MCP_DOCS_TOKEN（可选）"
        /></FormItem>
      </template>
      <div class="mcp-form-grid">
        <FormItem label="超时（毫秒）" html-for="mcp-timeout"
          ><InputNumber
            id="mcp-timeout"
            :value="form.timeoutMs"
            @update:value="(value) => (form.timeoutMs = Number(value || 10000))"
            :min="100"
            :max="60000"
            :step="1000"
        /></FormItem>
        <FormItem label="启用状态"
          ><Switch
            :checked="form.enabled"
            @update:checked="(value) => (form.enabled = Boolean(value))"
            aria-label="启用此服务"
        /></FormItem>
      </div>
      <FormItem
        label="允许的工具"
        html-for="mcp-tools"
        extra="先测试连接以发现工具；首版仅可选择参数 Schema 受支持的只读工具。"
        ><Select
          id="mcp-tools"
          :value="form.allowedTools"
          @update:value="(value) => (form.allowedTools = value as string[])"
          mode="multiple"
          :options="toolOptions"
          placeholder="测试连接后选择工具"
          :not-found-content="'请先测试连接'"
      /></FormItem>
      <FormItem
        label="绑定数字人"
        html-for="mcp-workers"
        extra="所选数字人可使用此服务允许的工具；留空只保存连接。"
        ><Select
          id="mcp-workers"
          :value="form.workerIds"
          @update:value="(value) => (form.workerIds = value as string[])"
          mode="multiple"
          :options="workerOptions"
          placeholder="选择数字人（可选）"
      /></FormItem>
    </Form>
    <template #footer
      ><div class="mcp-editor-footer">
        <Button :loading="probing" :disabled="saving" @click="probe">测试连接</Button
        ><Space
          ><Button :disabled="saving || probing" @click="close">取消</Button
          ><Button type="primary" :loading="saving" :disabled="probing" @click="save"
            >保存配置</Button
          ></Space
        >
      </div></template
    >
  </Drawer>

  <Modal
    :open="Boolean(details)"
    :title="details ? details.name + ' · 允许的工具' : '服务工具'"
    :footer="null"
    width="min(660px, calc(100vw - 32px))"
    @cancel="details = null"
  >
    <div class="mcp-tool-details">
      <Alert v-if="details?.error" :message="details.error.message" type="error" show-icon />
      <Empty
        v-if="!details?.tools.length"
        description="暂无已验证工具。编辑服务并测试连接后可重新选择。"
      />
      <Card v-for="tool in details?.tools" :key="tool.id" size="small" :title="tool.name">
        <template #extra><Tag color="green">只读</Tag></template>
        <p>{{ tool.description }}</p>
        <details>
          <summary>参数 Schema</summary>
          <pre>{{ JSON.stringify(tool.inputSchema, null, 2) }}</pre>
        </details>
      </Card>
    </div>
  </Modal>
</template>
