import { createFixedClock, SimulationEngine } from '@rescuemesh/engine';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createAdapters } from './adapters/index.js';
import type { FetchLike } from './adapters/gemini.js';
import type { GeminiConfig } from './config.js';
import { World } from './world.js';

const geminiConfig: GeminiConfig = {
  apiKey: 'test-key-not-a-real-credential',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.0-flash',
  timeoutMs: 5_000,
  maxOutputTokens: 1_024,
  temperature: 0.2
};

const geminiReply =
  (text: string): FetchLike =>
  async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

const fixedWorld = () =>
  new World(new SimulationEngine({ clock: createFixedClock('2026-07-18T18:40:00-04:00') }));

const mockApp = () => createApp({ adapters: createAdapters(null), world: fixedWorld() });
const liveApp = (fetchImpl?: FetchLike) =>
  createApp({ adapters: createAdapters(geminiConfig, fetchImpl), world: fixedWorld() });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** Loads the chiefs so the cache holds something approvable. */
const loadChiefs = async (app: ReturnType<typeof createApp>) => {
  const response = await request(app).get('/api/recommendations').expect(200);
  return response.body as {
    revision: number;
    items: {
      recommendation: { id: string; agent: string; proposedAction?: unknown; status: string };
      analyzedRevision: number;
    }[];
  };
};

describe('approval boundary', () => {
  it('converts an approved action into an engine command', async () => {
    const app = mockApp();
    const chiefs = await loadChiefs(app);
    const commander = chiefs.items.find((i) => i.recommendation.agent === 'incident_commander');
    expect(commander?.recommendation.proposedAction).toBeDefined();

    const response = await request(app)
      .post('/api/recommendations/approve')
      .send({ recommendationId: commander?.recommendation.id, analyzedRevision: chiefs.revision })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.command.ok).toBe(true);
    expect(response.body.command.type).toBe('plan.propose');
    // the engine, not the model, produced the plan
    expect(response.body.command.data.plan.generatedBy).toBe('mock');
    expect(response.body.revision).toBeGreaterThan(chiefs.revision);
  });

  it('refuses an advisory-only recommendation instead of inventing a command', async () => {
    const app = mockApp();
    const chiefs = await loadChiefs(app);
    const advisory = chiefs.items.find((i) => !i.recommendation.proposedAction);
    expect(advisory).toBeDefined();

    const response = await request(app)
      .post('/api/recommendations/approve')
      .send({ recommendationId: advisory?.recommendation.id, analyzedRevision: chiefs.revision })
      .expect(409);
    expect(response.body.refusal.code).toBe('advisory_only');
  });

  it('refuses a stale recommendation until it is revalidated', async () => {
    const app = mockApp();
    const chiefs = await loadChiefs(app);
    const commander = chiefs.items.find((i) => i.recommendation.agent === 'incident_commander');

    // world state moves on after the operator read the advice
    await request(app)
      .post('/api/commands')
      .send({
        type: 'zone.set_connectivity',
        commandId: 'move-1',
        issuedAt: '2026-07-18T18:40:00-04:00',
        payload: { zoneId: 'zone-east', connectivity: 'degraded' }
      })
      .expect(200);

    const stale = await request(app)
      .post('/api/recommendations/approve')
      .send({ recommendationId: commander?.recommendation.id, analyzedRevision: chiefs.revision })
      .expect(404);
    // the cache was invalidated by the command, so the advice no longer exists
    expect(stale.body.refusal.code).toBe('not_found');

    // revalidating means re-reading the chiefs at the current revision
    const refreshed = await loadChiefs(app);
    expect(refreshed.revision).toBeGreaterThan(chiefs.revision);
    const again = refreshed.items.find((i) => i.recommendation.agent === 'incident_commander');
    const ok = await request(app)
      .post('/api/recommendations/approve')
      .send({ recommendationId: again?.recommendation.id, analyzedRevision: refreshed.revision })
      .expect(200);
    expect(ok.body.ok).toBe(true);
  });

  it('refuses when the operator approves against a revision they no longer see', async () => {
    const app = mockApp();
    const chiefs = await loadChiefs(app);
    const commander = chiefs.items.find((i) => i.recommendation.agent === 'incident_commander');
    const response = await request(app)
      .post('/api/recommendations/approve')
      .send({
        recommendationId: commander?.recommendation.id,
        analyzedRevision: chiefs.revision + 5
      })
      .expect(409);
    expect(response.body.refusal.code).toBe('stale_recommendation');
    expect(response.body.refusal.currentRevision).toBe(chiefs.revision);
  });

  it('refuses an unknown recommendation id', async () => {
    const app = mockApp();
    await loadChiefs(app);
    const response = await request(app)
      .post('/api/recommendations/approve')
      .send({ recommendationId: 'rec-nope', analyzedRevision: 0 })
      .expect(404);
    expect(response.body.refusal.code).toBe('not_found');
  });

  it('validates the request shape', async () => {
    const app = mockApp();
    await request(app).post('/api/recommendations/approve').send({}).expect(400);
    await request(app)
      .post('/api/recommendations/approve')
      .send({ recommendationId: 'x', analyzedRevision: -1 })
      .expect(400);
  });

  it('drops an action that references an incident the model invented', async () => {
    const app = liveApp(
      geminiReply(
        '{"summary":"s","action":"a","confidence":0.8,"relatedIncidentId":null,' +
          '"proposePlan":{"incidentIds":["inc-imaginary"],"reserveUnitsPerKind":1}}'
      )
    );
    const chiefs = await loadChiefs(app);
    const action = chiefs.items[0]?.recommendation.proposedAction as
      { incidentIds?: string[] } | undefined;
    // the invented id is filtered out; what remains is a plain plan request
    expect(action?.incidentIds).toBeUndefined();
  });
});

describe('scripted scenario progression', () => {
  it('runs the six-step sequence with no model and no credentials', async () => {
    const app = mockApp();
    const steps = [
      'initial_flooding',
      'bridge_disruption',
      'evacuation_pressure',
      'zone_connectivity_loss',
      'response_adaptation',
      'stabilization'
    ];
    for (const step of steps) {
      const response = await request(app).post('/api/scenario/advance').send({ step }).expect(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data.source).toEqual({
        kind: 'scripted',
        version: 'recorded-pittsburgh-sequence-v1'
      });
      expect(response.body.data.applied.length).toBeGreaterThan(0);
    }
    const scenario = (await request(app).get('/api/scenario').expect(200)).body;
    expect(scenario.phase).toBe('stabilizing');
    const mix = (kind: string) =>
      scenario.facilities.filter((f: { kind: string }) => f.kind === kind).length;
    expect(mix('hospital')).toBe(3);
    expect(mix('fire_house')).toBeGreaterThanOrEqual(3);
    expect(mix('police_hub')).toBe(2);
    expect(mix('rescue_center')).toBe(2);
  });

  it('never labels recorded content as AI generated', async () => {
    const app = mockApp();
    const response = await request(app)
      .post('/api/scenario/advance')
      .send({ step: 'initial_flooding' })
      .expect(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/gemini|k2|generated by/i);
    expect(response.body.data.source.kind).toBe('scripted');
  });

  it('rejects an unknown step', async () => {
    await request(mockApp()).post('/api/scenario/advance').send({ step: 'apocalypse' }).expect(400);
  });

  it('reset clears the script ledger so a replay works', async () => {
    const app = mockApp();
    await request(app).post('/api/scenario/advance').send({ step: 'initial_flooding' }).expect(200);
    await request(app)
      .post('/api/commands')
      .send({
        type: 'scenario.reset',
        commandId: 'reset-1',
        issuedAt: '2026-07-18T18:40:00-04:00',
        payload: {}
      })
      .expect(200);
    const replay = await request(app)
      .post('/api/scenario/advance')
      .send({ step: 'initial_flooding' })
      .expect(200);
    expect(replay.body.ok).toBe(true);
    expect(replay.body.revision).toBe(1);
  });

  it('exposes the script without a provider or budget', async () => {
    const response = await request(mockApp()).get('/api/scenario/script').expect(200);
    expect(response.body.source).toBe('scripted');
    expect(response.body.steps).toHaveLength(6);
    expect(response.body).not.toHaveProperty('provider');
    expect(response.body).not.toHaveProperty('budget');
  });
});

describe('no K2 in the runtime path', () => {
  it('health never reports an ifm provider', async () => {
    for (const app of [mockApp(), liveApp()]) {
      const response = await request(app).get('/health').expect(200);
      expect(response.body.reasoning.provider).not.toBe('ifm');
      expect(['gemini', 'mock']).toContain(response.body.reasoning.provider);
      expect(response.body.mode).not.toContain('ifm');
    }
  });

  it('runs the whole demo with no IFM credential present', async () => {
    const saved = process.env.IFM_API_KEY;
    delete process.env.IFM_API_KEY;
    try {
      const app = mockApp();
      await request(app)
        .post('/api/scenario/advance')
        .send({ step: 'initial_flooding' })
        .expect(200);
      const chiefs = await loadChiefs(app);
      expect(chiefs.items).toHaveLength(5);
      const commander = chiefs.items.find((i) => i.recommendation.agent === 'incident_commander');
      await request(app)
        .post('/api/recommendations/approve')
        .send({ recommendationId: commander?.recommendation.id, analyzedRevision: chiefs.revision })
        .expect(200);
    } finally {
      if (saved !== undefined) process.env.IFM_API_KEY = saved;
    }
  });
});
