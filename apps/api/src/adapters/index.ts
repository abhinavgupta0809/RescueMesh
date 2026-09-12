import { loadEnvFile, readGeminiConfig, type GeminiConfig } from '../config.js';
import { GeminiClient, GeminiReasoningAdapter, type FetchLike } from './gemini.js';
import {
  MockAllocationAdapter,
  MockEdgeIntelligenceAdapter,
  MockGeographyAdapter,
  MockIdentityAdapter,
  MockReasoningAdapter,
  MockVoiceAdapter,
  MockWorldStateStore
} from './mock.js';
import { ResilientReasoningAdapter } from './reasoning.js';

export type Adapters = ReturnType<typeof createAdapters>;

/**
 * Gemini powers the five chiefs. When no Gemini key is present the
 * deterministic mock answers instead, with visible provenance.
 *
 * The IFM/K2 client is deliberately NOT wired here: it is retained as
 * development tooling (`npm run k2`, `npm run ifm:check`) and is never invoked
 * for chief reasoning.
 */
export const createAdapters = (config: GeminiConfig | null, fetchImpl?: FetchLike) => ({
  reasoning: new ResilientReasoningAdapter(
    config ? new GeminiReasoningAdapter(new GeminiClient(config, fetchImpl)) : null,
    new MockReasoningAdapter(),
    'gemini'
  ),
  allocation: new MockAllocationAdapter(),
  worldState: new MockWorldStateStore(),
  geography: new MockGeographyAdapter(),
  voice: new MockVoiceAdapter(),
  identity: new MockIdentityAdapter(),
  edge: new MockEdgeIntelligenceAdapter()
});

/** Reads `.env` once at startup so pasting a key is the only setup step. */
export const envFile = loadEnvFile();
export const geminiConfig = readGeminiConfig();
export const adapters = createAdapters(geminiConfig);

export * from './contracts.js';
export { ResilientReasoningAdapter } from './reasoning.js';
export { GeminiClient, GeminiError, GeminiReasoningAdapter } from './gemini.js';
export { ROLE_TITLES, roleBriefText, roleContext } from './prompts.js';
