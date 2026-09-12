import { createFixedClock, SimulationEngine } from '@rescuemesh/engine';
import { summarizeProvenance, type DeliberationSession } from '@rescuemesh/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createAdapters } from '../adapters/index.js';
import { GeminiClient, type FetchLike } from '../adapters/gemini.js';
import { diagnoseReply, looksTruncated } from '../adapters/gemini-failure.js';
import type { GeminiConfig } from '../config.js';
import { World } from '../world.js';
import { DELIBERATION_DEFAULTS, DeliberationOrchestrator } from './orchestrator.js';

const config: GeminiConfig = {
  apiKey: 'test-key-not-a-real-credential',
  baseUrl: 'https://example.invalid/v1beta',
  model: 'gemini-3.6-flash',
  timeoutMs: 5_000,
  maxOutputTokens: 8_192,
  temperature: 0.2
};

/** The exact shape of the production failure, from the screenshot. */
const TRUNCATED_LOGISTICS =
  '{"situationSummary":"log-1 is available with barriers and medical supplies. Incident ' +
  'evacuations from inc-southside and inc-parkway will strain local hospital capacity, with ' +
  'h-mercy and h-presby limited to 7 spare beds each, while h-agh retains 16 spare beds. ' +
  'Route p-zone1 to inc-trail is closed and';

const POSITION = {
  situationSummary: 'Supply movement is constrained near the closed crossing.',
  topPriorities: ['Pre-position barriers'],
  risks: ['A supply run behind a closed crossing strands the truck'],
  proposedActions: ['Stage barriers near the approach'],
  confidence: 0.8
};
const RESPONSE = {
  agreements: ['Entrapment first'],
  objections: [],
  revisedPriority: 'Swift-water rescue first',
  recommendation: 'Commit the reachable boat',
  confidence: 0.85
};
const BRIEF = {
  situationSummary: 'One critical entrapment dominates.',
  pointsOfAgreement: ['Entrapment first'],
  unresolvedDisputes: [],
  orderedPriorities: ['Swift-water rescue'],
  proposedActions: ['Request a plan'],
  rationale: 'All roles converge on the entrapment.',
  confidence: 0.9
};

const isReview = (s: string) => s.includes('read the other chiefs');
const isRepair = (s: string) => s.includes('could not be used');
const isInitial = (s: string) => !isReview(s) && !isRepair(s) && s.includes('opening position');

const provider = (
  handler: (system: string, n: number) => { status?: number; text?: string; finishReason?: string }
) => {
  let calls = 0;
  const bodies: Record<string, unknown>[] = [];
  const impl: FetchLike = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init.body)) as {
      systemInstruction: { parts: { text: string }[] };
      generationConfig: Record<string, unknown>;
    };
    bodies.push(body.generationConfig);
    const out = handler(body.systemInstruction.parts[0]?.text ?? '', calls);
    if (out.status && out.status !== 200)
      return new Response('provider error', { status: out.status });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: out.text ?? '{}' }] },
            finishReason: out.finishReason ?? 'STOP'
          }
        ]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  return { impl, count: () => calls, configs: () => bodies };
};

const build = (fetchImpl?: FetchLike) => {
  const world = new World(
    new SimulationEngine({ clock: createFixedClock('2026-07-18T18:40:00-04:00') })
  );
  const orchestrator = new DeliberationOrchestrator(
    world,
    fetchImpl ? new GeminiClient(config, fetchImpl) : null,
    { ...DELIBERATION_DEFAULTS, retryBackoffMs: 1 }
  );
  return {
    app: createApp({ adapters: createAdapters(null), world, deliberation: orchestrator }),
    world
  };
};
const settle = async (app: ReturnType<typeof createApp>, id: string) => {
  for (let i = 0; i < 120; i += 1) {
    const r = await request(app).get(`/api/simulations/${id}`).expect(200);
    const s = r.body.session as DeliberationSession;
    if (['ready', 'degraded', 'stale', 'failed'].includes(s.status)) return s;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('never settled');
};
const run = async (app: ReturnType<typeof createApp>) => {
  const started = await request(app).post('/api/simulations').send({}).expect(201);
  return settle(app, (started.body.session as DeliberationSession).sessionId);
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('root cause: truncation was reported as malformed', () => {
  it('detects the exact production reply as truncated, not malformed', () => {
    expect(looksTruncated(TRUNCATED_LOGISTICS)).toBe(true);
    // ...even though finishReason did NOT say MAX_TOKENS, which is why it slipped through
    const d = diagnoseReply(TRUNCATED_LOGISTICS, { finishReason: 'STOP' });
    expect(d.fault).toBe('truncated_json');
    expect(d.repairable).toBe(true);
  });

  it('separates the four reply faults', () => {
    expect(diagnoseReply('{"a":1}', { shapeReason: 'topPriorities empty' }).fault).toBe(
      'wrong_shape'
    );
    expect(diagnoseReply('{"a": }').fault).toBe('malformed_json');
    expect(diagnoseReply('I cannot help with that.').fault).toBe('no_json');
    expect(diagnoseReply('{"a":1', { finishReason: 'MAX_TOKENS' }).fault).toBe('truncated_json');
  });
});

describe('structured output', () => {
  it('sends a response schema on every deliberation call', async () => {
    const p = provider((s) =>
      isReview(s)
        ? { text: JSON.stringify(RESPONSE) }
        : isInitial(s)
          ? { text: JSON.stringify(POSITION) }
          : { text: JSON.stringify(BRIEF) }
    );
    const { app } = build(p.impl);
    await run(app);
    expect(p.configs()).toHaveLength(11);
    for (const cfg of p.configs()) {
      expect(cfg.responseMimeType).toBe('application/json');
      expect(cfg.responseSchema).toBeDefined();
      expect(cfg.maxOutputTokens).toBe(8_192);
    }
  });
});

describe('one bounded format repair', () => {
  const repairable = (badText: string) =>
    provider((s) => {
      if (isRepair(s)) return { text: JSON.stringify(POSITION) };
      if (isReview(s)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(s) && s.includes('Logistics Chief')) return { text: badText };
      if (isInitial(s)) return { text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });

  it('recovers a truncated reply — 12 calls, nothing substituted', async () => {
    const p = repairable(TRUNCATED_LOGISTICS);
    const { app } = build(p.impl);
    const s = await run(app);
    expect(s.initialPositions.filter((x) => x.substituted)).toHaveLength(0);
    expect(s.status).toBe('ready');
    expect(p.count()).toBe(12);
    expect(s.usage.calls).toBe(12);
  });

  it('recovers malformed JSON', async () => {
    const p = repairable('{"situationSummary": }');
    const { app } = build(p.impl);
    const s = await run(app);
    expect(s.initialPositions.filter((x) => x.substituted)).toHaveLength(0);
    expect(p.count()).toBe(12);
  });

  it('recovers valid JSON of the wrong shape', async () => {
    const p = repairable(JSON.stringify({ situationSummary: 'ok', topPriorities: [] }));
    const { app } = build(p.impl);
    const s = await run(app);
    expect(s.initialPositions.filter((x) => x.substituted)).toHaveLength(0);
    expect(p.count()).toBe(12);
  });

  it('falls back to the fixture when the repair also fails', async () => {
    const p = provider((s) => {
      if (isReview(s)) return { text: JSON.stringify(RESPONSE) };
      if ((isInitial(s) || isRepair(s)) && s.includes('Logistics Chief'))
        return { text: 'still broken' };
      if (isInitial(s)) return { text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(p.impl);
    const s = await run(app);
    const sub = s.initialPositions.filter((x) => x.substituted);
    expect(sub).toHaveLength(1);
    expect(sub[0]?.role).toBe('logistics_chief');
    expect(s.status).toBe('degraded');
    expect(p.count()).toBe(12); // one repair attempted, never two
  });

  it('a clean run stays at exactly eleven calls', async () => {
    const p = provider((s) =>
      isReview(s)
        ? { text: JSON.stringify(RESPONSE) }
        : isInitial(s)
          ? { text: JSON.stringify(POSITION) }
          : { text: JSON.stringify(BRIEF) }
    );
    const { app } = build(p.impl);
    const s = await run(app);
    expect(p.count()).toBe(11);
    expect(s.usage.calls).toBe(11);
  });

  it('never repairs an authentication failure', async () => {
    const p = provider((s) => {
      if (isInitial(s) && s.includes('Logistics Chief')) return { status: 401 };
      if (isReview(s)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(s)) return { text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(p.impl);
    await run(app);
    expect(p.count()).toBe(11); // no repair, no retry
  });

  it('never repairs a daily quota exhaustion', async () => {
    const daily = JSON.stringify({
      error: {
        code: 429,
        message: 'Quota exceeded. Please retry in 38.1s.',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }]
          }
        ]
      }
    });
    let calls = 0;
    const impl: FetchLike = async () => {
      calls += 1;
      return new Response(daily, { status: 429 });
    };
    const { app } = build(impl);
    const s = await run(app);
    expect(s.status).toBe('degraded');
    expect(calls).toBeLessThanOrEqual(DELIBERATION_DEFAULTS.concurrency);
  });
});

describe('contribution-specific provenance', () => {
  const mixed = async () => {
    const p = provider((s) => {
      if (isReview(s)) return { text: JSON.stringify(RESPONSE) };
      if ((isInitial(s) || isRepair(s)) && s.includes('Logistics Chief')) return { text: 'broken' };
      if (isInitial(s)) return { text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(p.impl);
    return run(app);
  };

  it('names the substituted contribution precisely and does not call the session fully live', async () => {
    const s = await mixed();
    const summary = summarizeProvenance(s);
    expect(summary.mode).toBe('mixed');
    expect(summary.substituted).toBe(1);
    expect(summary.live).toBe(10);
    expect(summary.headline).toContain('10 of 11');
    expect(summary.headline).toContain('Logistics Chief opening position');
    expect(summary.substitutedContributions).toEqual([
      { role: 'logistics_chief', stage: 'opening position' }
    ]);
  });

  it('marks only the substituted item, leaving successful Gemini items clean', async () => {
    const s = await mixed();
    const live = s.initialPositions.filter((p) => !p.substituted);
    expect(live).toHaveLength(4);
    for (const item of live) expect(item.substituted).toBeUndefined();
    expect(s.crossReview.every((r) => !r.substituted)).toBe(true);
  });

  it('describes a mixed synthesis honestly', async () => {
    const s = await mixed();
    const summary = summarizeProvenance(s);
    expect(summary.synthesisNote).toContain('live contributions');
    expect(summary.synthesisNote).toContain('recorded fallback');
  });

  it('reports a fully live session as fully live', async () => {
    const p = provider((s) =>
      isReview(s)
        ? { text: JSON.stringify(RESPONSE) }
        : isInitial(s)
          ? { text: JSON.stringify(POSITION) }
          : { text: JSON.stringify(BRIEF) }
    );
    const { app } = build(p.impl);
    const summary = summarizeProvenance(await run(app));
    expect(summary.mode).toBe('live');
    expect(summary.headline).toBe('11 of 11 contributions generated by Gemini.');
    expect(summary.synthesisNote).toContain('all live contributions');
  });

  it('reports a fully scripted session as recorded', async () => {
    const { app } = build();
    const summary = summarizeProvenance(await run(app));
    expect(summary.mode).toBe('scripted');
    expect(summary.headline).toBe('Recorded demonstration — no live Gemini calls.');
  });
});
