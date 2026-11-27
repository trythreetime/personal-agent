import OpenAI from 'openai';
import { OpenAIChatCompletionsModel, OpenAIResponsesModel } from '@openai/agents';
import type { CredentialResolver, ModelConfig } from '@digital-worker/core';
export function createModel(config: ModelConfig, credentials: CredentialResolver) {
  const client = new OpenAI({
    apiKey: credentials.resolve(config.apiKeyRef),
    baseURL: config.baseURL,
    maxRetries: 0,
    timeout: 120_000,
    // 文本会话采用最广泛兼容的字符串格式；SDK 仍负责完整的工具循环。
    ...(config.provider === 'openai-compatible' && config.protocol === 'chat_completions'
      ? {
          fetch: async (url: RequestInfo | URL, options?: RequestInit) => {
            if (typeof options?.body === 'string') {
              const body = JSON.parse(options.body);
              if (Array.isArray(body.messages))
                for (const message of body.messages) {
                  if (
                    Array.isArray(message.content) &&
                    message.content.every(
                      (part: { type?: string; text?: unknown }) =>
                        part.type === 'text' && typeof part.text === 'string',
                    )
                  ) {
                    message.content = message.content
                      .map((part: { text: string }) => part.text)
                      .join('\n');
                  }
                }
              return globalThis.fetch(url, { ...options, body: JSON.stringify(body) });
            }
            return globalThis.fetch(url, options);
          },
        }
      : {}),
  });
  return config.protocol === 'chat_completions'
    ? new OpenAIChatCompletionsModel(client, config.model)
    : new OpenAIResponsesModel(client, config.model);
}
