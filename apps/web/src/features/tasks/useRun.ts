import { ref, onUnmounted } from 'vue';
import { parseRunEvent, type RunEvent, type TaskDto, isTerminal } from '@digital-worker/contracts';
import { api, describeError } from '../../lib/api';
const eventNames = [
  'run.queued',
  'run.started',
  'output.delta',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.denied',
  'usage.updated',
  'run.completed',
  'run.failed',
  'run.cancelled',
];
export function useRun() {
  const task = ref<TaskDto | null>(null);
  const events = ref<RunEvent[]>([]);
  const text = ref('');
  const connection = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'>('idle');
  const error = ref('');
  let source: EventSource | null = null;
  let epoch = 0;
  const stop = () => {
    epoch++;
    source?.close();
    source = null;
    connection.value = 'idle';
  };
  async function load(id: string) {
    stop();
    const current = epoch;
    task.value = null;
    events.value = [];
    text.value = '';
    error.value = '';
    try {
      const value = await api<TaskDto>(`/tasks/${id}`);
      if (current !== epoch) return;
      task.value = value;
      connection.value = 'connecting';
      const seen = new Set<number>();
      const stream = new EventSource(`/api/runs/${value.run.id}/events?after=0`);
      source = stream;
      stream.onopen = () => {
        if (current === epoch) connection.value = 'connected';
      };
      stream.onerror = () => {
        if (current === epoch) connection.value = 'reconnecting';
      };
      for (const name of eventNames)
        stream.addEventListener(name, async (message) => {
          if (current !== epoch) return;
          try {
            const event = parseRunEvent(JSON.parse((message as MessageEvent).data));
            if (seen.has(event.seq)) return;
            seen.add(event.seq);
            events.value.push(event);
            if (event.type === 'output.delta') text.value += event.payload.delta;
            if (event.type === 'run.started' && task.value && !isTerminal(task.value.run.status))
              task.value.run.status = 'running';
            if (event.type === 'usage.updated' && task.value) task.value.run.usage = event.payload;
            if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
              stream.close();
              connection.value = 'closed';
              const latest = await api<TaskDto>(`/tasks/${id}`);
              if (current === epoch) task.value = latest;
            }
          } catch {
            if (current !== epoch) return;
            error.value = '读取执行事件失败，请刷新重试';
            stream.close();
            connection.value = 'closed';
          }
        });
    } catch (e) {
      if (current === epoch) error.value = describeError(e);
    }
  }
  async function cancel() {
    if (task.value) {
      try {
        await api(`/runs/${task.value.run.id}/cancel`, { method: 'POST' });
      } catch (e) {
        error.value = describeError(e);
      }
    }
  }
  onUnmounted(stop);
  return { task, events, text, connection, error, load, cancel, stop };
}
