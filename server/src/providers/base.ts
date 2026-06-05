import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freeaigateway/shared/types.js';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

/** Stored in place of a real key for a provider added in anonymous mode. The
 * provider treats this as "no key" and omits the Authorization header. */
export const ANON_KEY_SENTINEL = 'no-key';

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;
  /** Providers whose free tier needs no API key (e.g. Kilo's anonymous gateway).
   * When true, the gateway stores a sentinel key row so routing still considers
   * the platform "configured", and the provider omits the Authorization header
   * on outgoing requests. Defaults to false; set by subclasses. */
  keyless = false;
  /** Providers whose key is OPTIONAL: a real key is sent as a bearer when
   * present, but the provider also works anonymously (the anon sentinel → no
   * Authorization header). Kilo supports both. Defaults to false. */
  optionalKey = false;

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string): Promise<boolean>;

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
