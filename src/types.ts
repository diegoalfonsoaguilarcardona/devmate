import { ChatCompletionAssistantMessageParam, ChatCompletionSystemMessageParam, ChatCompletionUserMessageParam } from 'openai/resources/chat/completions';

export type ApiType = 'chatCompletions' | 'responses' | 'gemini';
export type AuthInfo = { apiKey?: string, apiUrl?: string };

export interface ModelPricing {
  unit?: 'per_1m_tokens' | 'per_token';
  currency?: string;
  input?: number;
  output?: number;
  cached_input?: number;
  cache_write?: number;
  cache_read?: number;
  reasoning?: number;
  input_audio?: number;
  output_audio?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
}

export interface SessionCostTotals {
  requestCount: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
}

export type Settings = {
  selectedInsideCodeblock?: boolean;
  codeblockWithLanguageId?: boolean;
  pasteOnClick?: boolean;
  keepConversation?: boolean;
  timeoutLength?: number;
  model?: string;
  apiUrl?: string;
  apiType?: ApiType;
  reasoningOutputDeltaPath?: string;
  pricing?: ModelPricing;
  options?: {
    [key: string]: any; // Allows for any number of properties with any value type
  };
};
export interface Model {
  name: string;            // Display in UI
  model_name: string;      // For API calls
  api?: ApiType; // Which API to use
  tools?: any[];           // Optional tools for Responses API (provider-specific)
  pricing?: ModelPricing;  // Optional pricing used for per-session cost estimation
  options: {
    [key: string]: any;
  };
  reasoning_output_delta_path?: string; // Optional path to reasoning delta in chat completions stream (e.g., choices[0].delta.reasoning)
}
export interface Provider {
  name: string;
  apiKey: string;
  apiUrl: string;                 // Fallback / legacy single URL
  chatCompletionsUrl?: string;    // Optional override for chat completions
  responsesUrl?: string;          // Optional URL for Responses API
  models: Model[];
}
export interface ProviderSettings {
  model: string;
  apiUrl: string;
  apiKey: string;
  apiType?: ApiType;
  pricing?: ModelPricing;
  options: {
    [key: string]: any; // This allows options to have any number of properties with any types
  };
}

export interface Prompt {
  name: string;
  prompt: string;
}
export interface ExportGptMessage {
  chat_id?: string;
  msg_id?: string;
  created_at?: string | null;
  role: string;
  content: string;
  content_type?: string;
  attachments?: any[];
}

export interface ExportGptConversation {
  messages?: ExportGptMessage[];
}


export interface SystemMessage extends ChatCompletionSystemMessageParam {
  selected?: boolean;  // Additional property specific to Message
  collapsed?: boolean; // UI-only: whether to render collapsed by default
  moveToEnd?: boolean; // UI-only: move file reference to end before each send (only meaningful for file reference-style content)
}

export interface UserMessage extends ChatCompletionUserMessageParam {
  selected?: boolean;  // Additional property specific to Message
  collapsed?: boolean; // UI-only: whether to render collapsed by default
  moveToEnd?: boolean; // UI-only: move file reference to end before each send (only meaningful for file reference-style content)
}

export interface AssistantMessage extends ChatCompletionAssistantMessageParam {
  selected?: boolean;  // Additional property specific to Message
  collapsed?: boolean; // UI-only: whether to render collapsed by default
  moveToEnd?: boolean; // UI-only: move file reference to end before each send (only meaningful for file reference-style content)
}

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage

export const BASE_URL = 'https://api.openai.com/v1';