import { loadEnvFile, readIfmConfig, type IfmConfig } from '../config.js';
import { IfmClient, IfmReasoningAdapter, type FetchLike } from './ifm.js';
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

export const createAdapters = (config: IfmConfig | null, fetchImpl?: FetchLike) => ({
  reasoning: new ResilientReasoningAdapter(
    config ? new IfmReasoningAdapter(new IfmClient(config, fetchImpl)) : null,
    new MockReasoningAdapter()
  ),
  allocation: new MockAllocationAdapter(),
  worldState: new MockWorldStateStore(),
  geography: new MockGeographyAdapter(),
  voice: new MockVoiceAdapter(),
  identity: new MockIdentityAdapter(),
  edge: new MockEdgeIntelligenceAdapter()
});

/** Reads `.env` once at startup so `IFM_API_KEY=...` is the only setup step. */
export const envFile = loadEnvFile();
export const ifmConfig = readIfmConfig();
export const adapters = createAdapters(ifmConfig);

export * from './contracts.js';
export * from './reasoning.js';
export { IfmClient, IfmError, IfmReasoningAdapter, ROLE_TITLES } from './ifm.js';
