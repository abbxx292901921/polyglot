// Polyglot — single source of truth for version + defaults.
// Phase 2/3 modules import from here so a preset change is one edit.

export const APP_VERSION = "v1.2.0";
export const CACHE_NAME = "polyglot-v1.2.0";
export const DB_NAME = "PolyglotDB";
export const DB_VERSION = 1;

export const DEFAULT_CONNECTION = {
  label: "Default",
  base_url: "https://api.openai.com",
  api_key: "",
  model: "",
  reasoning_strategy: "none", // "none" | "openai_effort" | "anthropic_budget" | "tag_only"
  reasoning_effort: "medium", // for openai_effort: "low" | "medium" | "high"
  thinking_budget: 2048, // for anthropic_budget, clamped >= 1024 at send time
  use_proxy: false,
  proxy_url: ""
};

export const DEFAULT_SAMPLERS = {
  temperature: 0.9,
  top_p: 1.0,
  top_k: 0,
  min_p: 0.0,
  max_tokens: 800,
  stop: [],
  frequency_penalty: 0.0,
  presence_penalty: 0.0,
  context_window_limit: 8192
};

export const DEFAULT_PROMPTS = {
  system: "You are {{char}}. Stay in character as {{char}} speaking to {{user}}.",
  jailbreak: "",
  authors_note: "",
  authors_note_depth: 2,
  prefill_enabled: false,
  prefill_text: "*"
};
