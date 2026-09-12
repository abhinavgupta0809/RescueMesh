import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Zero-dependency `.env` support. The demo deliberately avoids a dotenv
 * dependency so that pasting a key into `.env` is the only setup step.
 * Real environment variables always win over file values.
 */
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

const stripInlineComment = (value: string): string => {
  const marker = value.search(/\s#/);
  return marker === -1 ? value : value.slice(0, marker);
};

const unquote = (raw: string): string => {
  const value = raw.trim();
  const first = value.at(0);
  const last = value.at(-1);
  if (value.length >= 2 && (first === '"' || first === "'") && last === first) {
    const inner = value.slice(1, -1);
    return first === '"' ? inner.replaceAll('\\n', '\n') : inner;
  }
  return stripInlineComment(value).trim();
};

export const parseEnvFile = (contents: string): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = ENV_LINE.exec(line);
    const key = match?.[1];
    if (!key) continue;
    parsed[key] = unquote(match?.[2] ?? '');
  }
  return parsed;
};

/** Walks up from `startDir` looking for the repository `.env`. */
export const findEnvFile = (startDir: string = process.cwd()): string | undefined => {
  let current = resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
};

export const loadEnvFile = (
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd()
): { path?: string; applied: string[] } => {
  const path = findEnvFile(startDir);
  if (!path) return { applied: [] };
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, 'utf8')))) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      applied.push(key);
    }
  }
  return { path, applied };
};

export interface IfmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
}

/** Defaults taken verbatim from the IFM hosted-model quickstart. */
export const IFM_DEFAULTS = {
  baseUrl: 'https://api.ifm.ai/v1',
  model: 'IFM/K2-Horizon-375B-A23B',
  timeoutMs: 60_000,
  maxTokens: 8_000,
  temperature: 0.2
} as const;

/** Placeholder values that should be treated as "no key pasted yet". */
const PLACEHOLDER_KEYS = new Set(['ifm-xf...', 'your-key-here', 'paste-your-key-here', 'changeme']);

const numberFrom = (
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/** Returns `null` when no usable IFM key is present, which selects the mock path. */
export const readIfmConfig = (env: NodeJS.ProcessEnv = process.env): IfmConfig | null => {
  const apiKey = (env.IFM_API_KEY ?? '').trim();
  if (!apiKey || PLACEHOLDER_KEYS.has(apiKey.toLowerCase())) return null;
  return {
    apiKey,
    baseUrl: trimTrailingSlash((env.IFM_BASE_URL ?? '').trim() || IFM_DEFAULTS.baseUrl),
    model: (env.IFM_MODEL ?? '').trim() || IFM_DEFAULTS.model,
    timeoutMs: numberFrom(env.IFM_TIMEOUT_MS, IFM_DEFAULTS.timeoutMs, 1_000, 120_000),
    maxTokens: numberFrom(env.IFM_MAX_TOKENS, IFM_DEFAULTS.maxTokens, 64, 8_192),
    temperature: numberFrom(env.IFM_TEMPERATURE, IFM_DEFAULTS.temperature, 0, 2)
  };
};

export interface GeminiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature: number;
}

/** Defaults for the Gemini generateContent API. */
export const GEMINI_DEFAULTS = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-3.6-flash',
  timeoutMs: 45_000,
  maxOutputTokens: 8_192,
  temperature: 0.2
} as const;

const GEMINI_PLACEHOLDERS = new Set([
  'aiza...',
  'your-key-here',
  'paste-your-key-here',
  'changeme'
]);

/**
 * Returns `null` when no usable Gemini key is present, which selects the
 * deterministic mock path for the chiefs. Read on the backend only.
 */
export const readGeminiConfig = (env: NodeJS.ProcessEnv = process.env): GeminiConfig | null => {
  const apiKey = (env.GEMINI_API_KEY ?? '').trim();
  if (!apiKey || GEMINI_PLACEHOLDERS.has(apiKey.toLowerCase())) return null;
  return {
    apiKey,
    baseUrl: trimTrailingSlash((env.GEMINI_BASE_URL ?? '').trim() || GEMINI_DEFAULTS.baseUrl),
    model: (env.GEMINI_MODEL ?? '').trim() || GEMINI_DEFAULTS.model,
    timeoutMs: numberFrom(env.GEMINI_TIMEOUT_MS, GEMINI_DEFAULTS.timeoutMs, 1_000, 120_000),
    maxOutputTokens: numberFrom(
      env.GEMINI_MAX_OUTPUT_TOKENS,
      GEMINI_DEFAULTS.maxOutputTokens,
      64,
      8_192
    ),
    temperature: numberFrom(env.GEMINI_TEMPERATURE, GEMINI_DEFAULTS.temperature, 0, 2)
  };
};
