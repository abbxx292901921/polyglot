// Polyglot — single source of truth for version + defaults.
// Phase 2/3 modules import from here so a preset change is one edit.
export const APP_VERSION = "v1.5.1";

export const CACHE_NAME = "polyglot-v1.5.1";
export const DB_NAME = "PolyglotDB";
export const DB_VERSION = 3;

export const DEFAULT_PROVIDER = {
  name: "Default",
  base_url: "https://api.openai.com",
  api_key: "",
  use_proxy: false,
  proxy_url: ""
};

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

// Phase 4: theme presets. Applied as CSS vars on :root via app.js applyTheme().
// action = *asterisk* thought/action color, dialogue = "quoted" speech color.
export const THEMES = {
  polyglot: {
    label: "Polyglot Dark",
    bg: "#0f1420", bg2: "#151c2e", panel: "#1a2338",
    ink: "#e8ecf4", muted: "#9aa6c2", line: "#2a3654",
    accent: "#7c9bff", action: "#9aa6c2", dialogue: "#ffa14d"
  },
  agnai: {
    label: "Agnai Brown",
    bg: "#241a18", bg2: "#342622", panel: "#43302b",
    ink: "#f5ece6", muted: "#c9a89c", line: "#5a4038",
    accent: "#e8a25e", action: "#a89a93", dialogue: "#ff9c41"
  },
  amoled: {
    label: "AMOLED",
    bg: "#000000", bg2: "#0a0a0c", panel: "#141418",
    ink: "#f2f2f5", muted: "#9a9aa5", line: "#26262e",
    accent: "#8ab4ff", action: "#9a9aa5", dialogue: "#ffb020"
  },
  light: {
    label: "Paper Light",
    bg: "#f5f2ec", bg2: "#ffffff", panel: "#ffffff",
    ink: "#1c1a17", muted: "#6b6259", line: "#ddd5c8",
    accent: "#3b5bff", action: "#6b6259", dialogue: "#c25e00"
  }
};
