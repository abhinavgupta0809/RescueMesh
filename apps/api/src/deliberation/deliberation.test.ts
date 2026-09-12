import { createFixedClock, SimulationEngine } from '@rescuemesh/engine';
import { DELIBERATION_CALL_COUNT, type DeliberationSession } from '@rescuemesh/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createAdapters } from '../adapters/index.js';
import { GeminiClient, type FetchLike } from '../adapters/gemini.js';
import type { GeminiConfig } from '../config.js';
import { World } from '../world.js';
import {
  DELIBERATION_DEFAULTS,
  DeliberationOrchestrator,
  mapWithConcurrency
} from './orchestrator.js';

const config: GeminiConfig = {
  apiKey: 'test-key-not-a-real-credential',
  baseUrl: 'https://example.invalid/v1beta',
  model: 'gemini-3.6-flash',
  timeoutMs: 5_000,
  maxOutputTokens: 4_096,
  temperature: 0.2
};

const POSITION = {
  situationSummary: 'Critical entrapment dominates; access is constrained.',
  topPriorities: ['Life safety at the entrapment', 'Hold a reserve'],
  risks: ['No swift-water capacity left if both boats commit'],
  proposedActions: ['Request a plan for the entrapment'],
  confidence: 0.85
};
const RESPONSE = {
  agreements: ['Entrapment is the priority'],
  objections: ['Do not commit the last unit'],
  revisedPriority: 'Swift-water rescue first',
  recommendation: 'Commit the reachable boat, hold the other',
  confidence: 0.88
};
const BRIEF = {
  situationSummary: 'One critical entrapment with two supporting incidents.',
  pointsOfAgreement: ['Entrapment is the priority'],
  unresolvedDisputes: ['Whether logistics stages forward'],
  orderedPriorities: ['Swift-water rescue', 'Traffic control'],
  proposedActions: ['Request a resource plan'],
  rationale: 'All roles converge on the entrapment as the only life-safety-critical incident.',
  confidence: 0.9
};

/**
 * Round discriminators. Order matters: the cross-review prompt also contains
 * the words "opening positions", so it must be tested first.
 */
const isReview = (system: string) => system.includes('read the other chiefs');
const isInitial = (system: string) => !isReview(system) && system.includes('opening position');

/** Replies by round, so a test can control each of the eleven calls. */
const scriptedFetch = (
  handler: (system: string, call: number) => { status?: number; text?: string; delayMs?: number }
) => {
  let calls = 0;
  const impl: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      systemInstruction: { parts: { text: string }[] };
    };
    const system = body.systemInstruction.parts[0]?.text ?? '';
    const outcome = handler(system, ++calls);
    if (outcome.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, outcome.delayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if (outcome.status && outcome.status !== 200)
      return new Response('provider error', { status: outcome.status });
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: outcome.text ?? '{}' }] } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  return { impl, count: () => calls };
};

const happyPath = () =>
  scriptedFetch((system) => {
    if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
    if (isInitial(system)) return { text: JSON.stringify(POSITION) };
    return { text: JSON.stringify(BRIEF) };
  });

const fixedWorld = () =>
  new World(new SimulationEngine({ clock: createFixedClock('2026-07-18T18:40:00-04:00') }));

const build = (
  fetchImpl?: FetchLike,
  world = fixedWorld(),
  limits = { ...DELIBERATION_DEFAULTS, retryBackoffMs: 1 }
) => {
  const orchestrator = new DeliberationOrchestrator(
    world,
    fetchImpl ? new GeminiClient(config, fetchImpl) : null,
    limits
  );
  const app = createApp({ adapters: createAdapters(null), world, deliberation: orchestrator });
  return { app, world, orchestrator };
};

/** Polls until the session reaches a terminal state. Makes no model calls. */
const settle = async (
  app: ReturnType<typeof createApp>,
  sessionId: string
): Promise<DeliberationSession> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request(app).get(`/api/simulations/${sessionId}`).expect(200);
    const session = response.body.session as DeliberationSession;
    if (['ready', 'degraded', 'stale', 'failed'].includes(session.status)) return session;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('session never settled');
};

const startSim = async (app: ReturnType<typeof createApp>, body: object = {}) => {
  const response = await request(app).post('/api/simulations').send(body).expect(201);
  return response.body.session as DeliberationSession;
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('three rounds over one frozen snapshot', () => {
  it('runs five initial, five cross-review and one synthesis — exactly eleven calls', async () => {
    const gemini = happyPath();
    const { app } = build(gemini.impl);
    const started = await startSim(app);
    const session = await settle(app, started.sessionId);

    expect(session.status).toBe('ready');
    expect(session.initialPositions).toHaveLength(5);
    expect(session.crossReview).toHaveLength(5);
    expect(session.finalBrief).toBeDefined();
    expect(gemini.count()).toBe(DELIBERATION_CALL_COUNT);
    expect(session.usage.calls).toBe(DELIBERATION_CALL_COUNT);
    expect(session.source).toMatchObject({ provider: 'gemini', degraded: false });
  });

  it('gives all five roles a position and a response', async () => {
    const { app } = build(happyPath().impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    const roles = [
      'incident_commander',
      'medical_chief',
      'police_chief',
      'rescue_chief',
      'logistics_chief'
    ];
    expect(session.initialPositions.map((p) => p.role).sort()).toEqual([...roles].sort());
    expect(session.crossReview.map((r) => r.role).sort()).toEqual([...roles].sort());
  });

  it('cross-review runs only after the initial positions validate, and sees them', async () => {
    const seen: string[] = [];
    const gemini = scriptedFetch((system) => {
      if (isReview(system)) {
        // every initial call must already have happened
        expect(seen.filter((s) => s === 'initial')).toHaveLength(5);
        seen.push('review');
        return { text: JSON.stringify(RESPONSE) };
      }
      if (isInitial(system)) {
        seen.push('initial');
        return { text: JSON.stringify(POSITION) };
      }
      expect(seen.filter((s) => s === 'review')).toHaveLength(5);
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('ready');
  });

  it('sends each chief the other four positions, never its own', async () => {
    const prompts: string[] = [];
    const gemini = scriptedFetch((system) => {
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) return { text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const wrapped: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init.body)) as {
        systemInstruction: { parts: { text: string }[] };
        contents: { parts: { text: string }[] }[];
      };
      if (isReview(body.systemInstruction.parts[0]?.text ?? '')) {
        prompts.push(body.contents[0]?.parts[0]?.text ?? '');
      }
      return gemini.impl(url, init);
    };
    const { app } = build(wrapped);
    await settle(app, (await startSim(app)).sessionId);
    expect(prompts).toHaveLength(5);
    for (const prompt of prompts) {
      const digest = prompt.split('Your own world-state slice')[0] ?? '';
      // four other chiefs named in the digest, not five
      const named = [
        'Incident Commander',
        'Medical Chief',
        'Police Chief',
        'Rescue Chief',
        'Logistics Chief'
      ].filter((title) => digest.includes(title));
      expect(named).toHaveLength(4);
    }
  });

  it('never asks for hidden reasoning', async () => {
    const systems: string[] = [];
    const gemini = happyPath();
    const wrapped: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init.body)) as {
        systemInstruction: { parts: { text: string }[] };
      };
      systems.push(body.systemInstruction.parts[0]?.text ?? '');
      return gemini.impl(url, init);
    };
    const { app } = build(wrapped);
    await settle(app, (await startSim(app)).sessionId);
    expect(systems).toHaveLength(DELIBERATION_CALL_COUNT);
    for (const system of systems) {
      expect(system).toMatch(/Do not include reasoning steps/);
      expect(system).not.toMatch(/chain[- ]of[- ]thought|think step by step|show your work/i);
    }
  });
});

describe('failure handling', () => {
  it('substitutes one failing chief from the fixture and marks the session degraded', async () => {
    // Rescue Chief fails on every attempt, so the retry cannot rescue it and the
    // fixture must stand in. Every other role succeeds normally.
    const gemini = scriptedFetch((system) => {
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) {
        if (system.includes('Rescue Chief')) return { status: 503 };
        return { text: JSON.stringify(POSITION) };
      }
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);

    expect(session.status).toBe('degraded');
    expect(session.initialPositions).toHaveLength(5);
    expect(session.initialPositions.filter((p) => p.substituted)).toHaveLength(1);
    expect(session.source.degraded).toBe(true);
    expect(session.errors.some((e) => e.code === 'provider_unavailable')).toBe(true);
  });

  it('substitutes malformed output rather than storing it', async () => {
    const gemini = scriptedFetch((system) => {
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) return { text: 'I cannot help with that.' };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('degraded');
    expect(session.initialPositions.every((p) => p.substituted)).toBe(true);
    expect(session.errors.some((e) => e.code === 'malformed_output')).toBe(true);
  });

  it('rejects a position that breaks the contract bounds', async () => {
    const tooMany = { ...POSITION, topPriorities: ['a', 'b', 'c', 'd'] };
    const gemini = scriptedFetch((system) => {
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) return { text: JSON.stringify(tooMany) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.initialPositions.every((p) => p.substituted)).toBe(true);
    expect(session.errors.some((e) => e.message.includes('topPriorities'))).toBe(true);
  });

  it('treats a timeout as a failed contribution, not a hung session', async () => {
    const gemini = scriptedFetch((system) => {
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) return { delayMs: 60, text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const world = fixedWorld();
    const orchestrator = new DeliberationOrchestrator(
      world,
      new GeminiClient({ ...config, timeoutMs: 20 }, gemini.impl),
      { ...DELIBERATION_DEFAULTS, retryBackoffMs: 1 }
    );
    const app = createApp({ adapters: createAdapters(null), world, deliberation: orchestrator });
    const session = await settle(app, (await startSim(app)).sessionId);
    // retried once, still too slow, so the fixture stands in
    expect(session.status).toBe('degraded');
    expect(session.errors.some((e) => e.code === 'timeout')).toBe(true);
  });

  it('runs entirely on the fixture with no credential, labelled scripted', async () => {
    const { app } = build(undefined);
    const session = await settle(app, (await startSim(app)).sessionId);
    // the contract defines degraded as "completed on the scripted fallback"
    expect(session.status).toBe('degraded');
    expect(session.source.provider).toBe('scripted');
    expect(session.source.model).toBe('recorded-deliberation-v1');
    expect(session.usage.calls).toBe(0);
    expect(JSON.stringify(session)).not.toMatch(/gemini-generated/i);
  });
});

describe('staleness and world-state safety', () => {
  it('marks a completed session stale once world state moves', async () => {
    const { app, world } = build(happyPath().impl);
    const started = await startSim(app);
    const ready = await settle(app, started.sessionId);
    expect(ready.status).toBe('ready');

    world.execute({
      type: 'zone.set_connectivity',
      commandId: 'move-1',
      issuedAt: '2026-07-18T18:40:00-04:00',
      payload: { zoneId: 'zone-east', connectivity: 'degraded' }
    });

    const after = await request(app).get(`/api/simulations/${started.sessionId}`).expect(200);
    expect((after.body.session as DeliberationSession).status).toBe('stale');
  });

  it('refuses a final plan for a stale session', async () => {
    const { app, world } = build(happyPath().impl);
    const started = await startSim(app);
    await settle(app, started.sessionId);
    world.execute({
      type: 'zone.set_connectivity',
      commandId: 'move-2',
      issuedAt: '2026-07-18T18:40:00-04:00',
      payload: { zoneId: 'zone-east', connectivity: 'degraded' }
    });
    const response = await request(app)
      .post(`/api/simulations/${started.sessionId}/final-plan`)
      .expect(409);
    expect(response.body.error).toBe('stale_session');
  });

  it('model output cannot change world state', async () => {
    const { app, world } = build(happyPath().impl);
    const before = world.scenario;
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('ready');
    // eleven model calls later, the world is untouched
    expect(world.scenario).toEqual(before);
  });

  it('reset clears the active deliberation', async () => {
    const { app } = build(happyPath().impl);
    const started = await startSim(app);
    await settle(app, started.sessionId);
    await request(app)
      .post('/api/commands')
      .send({
        type: 'scenario.reset',
        commandId: 'reset-1',
        issuedAt: '2026-07-18T18:40:00-04:00',
        payload: {}
      })
      .expect(200);
    await request(app).get(`/api/simulations/${started.sessionId}`).expect(404);
  });
});

describe('session API', () => {
  it('a duplicate Simulate with the same requestId returns the same session', async () => {
    const gemini = happyPath();
    const { app } = build(gemini.impl);
    const first = await request(app)
      .post('/api/simulations')
      .send({ requestId: 'press-1' })
      .expect(201);
    await settle(app, (first.body.session as DeliberationSession).sessionId);

    const second = await request(app)
      .post('/api/simulations')
      .send({ requestId: 'press-1' })
      .expect(200);
    expect(second.body.duplicate).toBe(true);
    expect((second.body.session as DeliberationSession).sessionId).toBe(
      (first.body.session as DeliberationSession).sessionId
    );
    expect(gemini.count()).toBe(DELIBERATION_CALL_COUNT);
  });

  it('polling makes no additional model calls', async () => {
    const gemini = happyPath();
    const { app } = build(gemini.impl);
    const started = await startSim(app);
    await settle(app, started.sessionId);
    const afterSettle = gemini.count();
    for (let i = 0; i < 6; i += 1) {
      await request(app).get(`/api/simulations/${started.sessionId}`).expect(200);
    }
    expect(gemini.count()).toBe(afterSettle);
    expect(gemini.count()).toBe(DELIBERATION_CALL_COUNT);
  });

  it('advances the scripted scenario and deliberates on the resulting revision', async () => {
    const { app, world } = build(happyPath().impl);
    const started = await startSim(app, { step: 'initial_flooding' });
    expect(world.revision).toBe(1);
    expect(started.scenarioRevision).toBe(1);
    expect(started.scenarioStep).toBe('initial_flooding');
    const session = await settle(app, started.sessionId);
    expect(session.status).toBe('ready');
  });

  it('rejects an unknown step and an unknown session', async () => {
    const { app } = build(happyPath().impl);
    await request(app).post('/api/simulations').send({ step: 'apocalypse' }).expect(400);
    await request(app).get('/api/simulations/sim-nope').expect(404);
    await request(app).post('/api/simulations/sim-nope/final-plan').expect(404);
  });

  it('refuses a final plan before synthesis completes', async () => {
    const slow = scriptedFetch((system) => {
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) return { delayMs: 200, text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(slow.impl);
    const started = await startSim(app);
    const response = await request(app)
      .post(`/api/simulations/${started.sessionId}/final-plan`)
      .expect(409);
    expect(response.body.error).toBe('not_ready');
    await settle(app, started.sessionId);
  });
});

describe('final plan and the approval boundary', () => {
  it('produces a deterministic plan the engine validated, without dispatching', async () => {
    const { app, world } = build(happyPath().impl);
    const started = await startSim(app);
    await settle(app, started.sessionId);

    const heldBefore = world.scenario.assignments
      .filter((a) => a.status === 'approved' || a.status === 'dispatched')
      .flatMap((a) => a.resourceIds);

    const response = await request(app)
      .post(`/api/simulations/${started.sessionId}/final-plan`)
      .expect(200);
    expect(response.body.planId).toMatch(/^plan-/);
    expect(response.body.command.data.plan.status).toBe('proposed');
    // the allocator produced it, not the model
    expect(response.body.command.data.plan.generatedBy).toBe('mock');

    const heldAfter = world.scenario.assignments
      .filter((a) => a.status === 'approved' || a.status === 'dispatched')
      .flatMap((a) => a.resourceIds);
    expect(heldAfter).toEqual(heldBefore);
  });

  it('only operator approval executes the plan', async () => {
    const { app, world } = build(happyPath().impl);
    const started = await startSim(app);
    await settle(app, started.sessionId);
    const plan = await request(app)
      .post(`/api/simulations/${started.sessionId}/final-plan`)
      .expect(200);

    const before = world.scenario.resources.filter((r) => r.status === 'assigned').length;
    const approved = await request(app)
      .post('/api/commands')
      .send({
        type: 'plan.approve',
        commandId: 'operator-approves',
        issuedAt: '2026-07-18T18:40:00-04:00',
        payload: { planId: plan.body.planId }
      })
      .expect(200);
    expect(approved.body.ok).toBe(true);
    const after = world.scenario.resources.filter((r) => r.status === 'assigned').length;
    expect(after).toBeGreaterThan(before);

    const held = world.scenario.assignments
      .filter((a) => a.status === 'approved' || a.status === 'dispatched')
      .flatMap((a) => a.resourceIds);
    expect(new Set(held).size).toBe(held.length);
  });

  it('a repeated final-plan request does not create a second plan', async () => {
    const { app, world } = build(happyPath().impl);
    const started = await startSim(app);
    await settle(app, started.sessionId);
    await request(app).post(`/api/simulations/${started.sessionId}/final-plan`).expect(200);
    const again = await request(app)
      .post(`/api/simulations/${started.sessionId}/final-plan`)
      .expect(200);
    expect(again.body.duplicate).toBe(true);
    expect(world.scenario.plans.filter((p) => p.status === 'proposed')).toHaveLength(1);
  });
});

describe('rate-limit hardening', () => {
  it('never exceeds the configured concurrency within a round', async () => {
    let inFlight = 0;
    let peak = 0;
    const gemini = scriptedFetch(() => ({ delayMs: 15 }));
    const impl: FetchLike = async (url, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        const body = JSON.parse(String(init.body)) as {
          systemInstruction: { parts: { text: string }[] };
        };
        const system = body.systemInstruction.parts[0]?.text ?? '';
        const text = isReview(system)
          ? JSON.stringify(RESPONSE)
          : isInitial(system)
            ? JSON.stringify(POSITION)
            : JSON.stringify(BRIEF);
        await new Promise((r) => setTimeout(r, 15));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } finally {
        inFlight -= 1;
      }
    };
    void gemini;
    const { app } = build(impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('ready');
    expect(peak).toBeLessThanOrEqual(DELIBERATION_DEFAULTS.concurrency);
    expect(peak).toBeGreaterThan(1);
  });

  it('retries a 429 once and recovers the chief', async () => {
    let rateLimited = 0;
    const gemini = scriptedFetch((system) => {
      if (isInitial(system) && rateLimited === 0) {
        rateLimited += 1;
        return { status: 429 };
      }
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) return { text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);

    // the retry recovered it, so nothing was substituted and nothing degraded
    expect(session.status).toBe('ready');
    expect(session.initialPositions.filter((p) => p.substituted)).toHaveLength(0);
    // 11 logical calls + 1 retry
    expect(gemini.count()).toBe(DELIBERATION_CALL_COUNT + 1);
  });

  it('retries a timeout once', async () => {
    let slow = 0;
    const gemini = scriptedFetch((system) => {
      if (isInitial(system) && slow === 0) {
        slow += 1;
        return { delayMs: 200, text: JSON.stringify(POSITION) };
      }
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) return { text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const world = fixedWorld();
    const orchestrator = new DeliberationOrchestrator(
      world,
      new GeminiClient({ ...config, timeoutMs: 40 }, gemini.impl),
      { ...DELIBERATION_DEFAULTS, retryBackoffMs: 1 }
    );
    const app = createApp({ adapters: createAdapters(null), world, deliberation: orchestrator });
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('ready');
    expect(gemini.count()).toBe(DELIBERATION_CALL_COUNT + 1);
  });

  it('does NOT retry a bad key, which would only burn quota', async () => {
    const gemini = scriptedFetch((system) => {
      if (isInitial(system)) return { status: 401 };
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('degraded');
    expect(session.initialPositions.every((p) => p.substituted)).toBe(true);
    // five failed initial calls, no retries, then five reviews and one synthesis
    expect(gemini.count()).toBe(DELIBERATION_CALL_COUNT);
  });

  it('gives up after one retry rather than looping', async () => {
    const gemini = scriptedFetch((system) => {
      if (isInitial(system)) return { status: 429 };
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('degraded');
    // 5 initial x 2 attempts, plus 5 reviews and 1 synthesis
    expect(gemini.count()).toBe(5 * 2 + 6);
  });

  it('still makes exactly eleven calls when nothing fails', async () => {
    const gemini = happyPath();
    const { app } = build(gemini.impl);
    await settle(app, (await startSim(app)).sessionId);
    expect(gemini.count()).toBe(DELIBERATION_CALL_COUNT);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and respects the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});

describe('daily quota exhaustion', () => {
  /** The exact body the live free tier returns at 20 requests/day. */
  const DAILY_QUOTA_BODY = JSON.stringify({
    error: {
      code: 429,
      message:
        'You exceeded your current quota. * Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash Please retry in 38.1s.',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }
          ]
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '38s' }
      ]
    }
  });

  const quotaFetch = () => {
    let calls = 0;
    const impl: FetchLike = async () => {
      calls += 1;
      return new Response(DAILY_QUOTA_BODY, { status: 429 });
    };
    return { impl, count: () => calls };
  };

  it('does not retry a daily quota 429', async () => {
    const gemini = quotaFetch();
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('degraded');
    // The first wave is already in flight when the breaker trips, so at most
    // `concurrency` calls are spent discovering it — never 11, and never 22.
    expect(gemini.count()).toBeLessThanOrEqual(DELIBERATION_DEFAULTS.concurrency);
    expect(gemini.count()).toBeLessThan(DELIBERATION_CALL_COUNT);
  });

  it('skips the whole session once the daily quota is gone', async () => {
    const gemini = quotaFetch();
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    // every artefact still present, all from the fixture
    expect(session.initialPositions).toHaveLength(5);
    expect(session.crossReview).toHaveLength(5);
    expect(session.finalBrief).toBeDefined();
    expect(session.initialPositions.every((p) => p.substituted)).toBe(true);
    expect(session.source.degraded).toBe(true);
    expect(gemini.count()).toBeLessThanOrEqual(DELIBERATION_DEFAULTS.concurrency);
  });

  it('still retries a burst limit that is not a daily cap', async () => {
    let burst = 0;
    const gemini = scriptedFetch((system) => {
      if (isInitial(system) && burst === 0) {
        burst += 1;
        return { status: 503 };
      }
      if (isReview(system)) return { text: JSON.stringify(RESPONSE) };
      if (isInitial(system)) return { text: JSON.stringify(POSITION) };
      return { text: JSON.stringify(BRIEF) };
    });
    const { app } = build(gemini.impl);
    const session = await settle(app, (await startSim(app)).sessionId);
    expect(session.status).toBe('ready');
    expect(gemini.count()).toBe(DELIBERATION_CALL_COUNT + 1);
  });
});
