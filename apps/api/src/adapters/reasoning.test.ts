import { pittsburghFloodScenario, type AgentRecommendation } from '@rescuemesh/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReasoningAdapter } from './contracts.js';
import { IfmError } from './ifm.js';
import { MockReasoningAdapter } from './mock.js';
import { ResilientReasoningAdapter } from './reasoning.js';

const liveAdapter = (
  overrides: Partial<ReasoningAdapter> = {}
): ReasoningAdapter & { model: string } => ({
  model: 'IFM/K2-Horizon-375B-A23B',
  parseReport: async () => ({
    title: 'K2 draft',
    description: 'From the model.',
    severity: 'high' as const
  }),
  recommend: async () =>
    ({
      id: 'rec-live',
      agent: 'medical_chief',
      summary: 'live',
      action: 'live action',
      confidence: 0.9,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'pending'
    }) satisfies AgentRecommendation,
  ...overrides
});

describe('ResilientReasoningAdapter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('reports mock provenance when no key is configured', async () => {
    const adapter = new ResilientReasoningAdapter(null, new MockReasoningAdapter());
    expect(adapter.configured).toBe(false);
    expect(adapter.model).toBe('deterministic-mock');

    const { value, source } = await adapter.parseReportWithSource('two people trapped');
    expect(source).toEqual({ provider: 'mock', model: 'deterministic-mock', degraded: false });
    expect(value.severity).toBe('critical');
  });

  it('uses IFM and reports it as the source when the call succeeds', async () => {
    const adapter = new ResilientReasoningAdapter(liveAdapter(), new MockReasoningAdapter());
    expect(adapter.configured).toBe(true);

    const { value, source } = await adapter.parseReportWithSource('water over the road');
    expect(value.title).toBe('K2 draft');
    expect(source).toEqual({
      provider: 'ifm',
      model: 'IFM/K2-Horizon-375B-A23B',
      degraded: false
    });
  });

  it('falls back to the deterministic mock and flags the answer as degraded', async () => {
    const adapter = new ResilientReasoningAdapter(
      liveAdapter({
        parseReport: async () => {
          throw new IfmError('http', 'IFM API returned 401 Unauthorized', 'invalid api key');
        }
      }),
      new MockReasoningAdapter()
    );

    const { value, source } = await adapter.parseReportWithSource('two people trapped');
    expect(value.severity).toBe('critical');
    expect(source.provider).toBe('mock');
    expect(source.degraded).toBe(true);
    expect(source.warning).toContain('401');
    expect(source.warning).toContain('invalid api key');
  });

  it('falls back for recommendations too, so bad output never reaches world state', async () => {
    const adapter = new ResilientReasoningAdapter(
      liveAdapter({
        recommend: async () => {
          throw new IfmError('shape', 'Model reply was not valid JSON');
        }
      }),
      new MockReasoningAdapter()
    );

    const { value, source } = await adapter.recommendWithSource(
      'logistics_chief',
      pittsburghFloodScenario
    );
    expect(value.agent).toBe('logistics_chief');
    expect(source).toMatchObject({ provider: 'mock', degraded: true });
  });
});
