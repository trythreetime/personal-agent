export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new ApiError(body.code ?? 'REQUEST_FAILED', body.message ?? '请求失败');
  return body as T;
}
export function describeError(error: unknown) {
  return error instanceof ApiError ? error.message : '连接失败，请确认服务已启动后重试';
}
export const statusLabels = {
  queued: '等待执行',
  running: '执行中',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};
export const statusColors = {
  queued: 'default',
  running: 'processing',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'default',
} as const;
export function dateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
