import { createFixedClock, SimulationEngine } from '@rescuemesh/engine';
import { pittsburghFloodScenario, type Command, type CommandResponse } from '@rescuemesh/shared';
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

/** A deterministic world: fixed clock and seeded RNG, so runs are repeatable. */
const fixedWorld = () =>
  new World(new SimulationEngine({ clock: createFixedClock('2026-07-18T18:40:00-04:00') }));

const mockApp = () => createApp({ adapters: createAdapters(null), world: fixedWorld() });

const liveApp = (fetchImpl?: FetchLike) =>
  createApp({ adapters: createAdapters(geminiConfig, fetchImpl), world: fixedWorld() });

let counter = 0;
const command = (type: Command['type'], payload: unknown, expectedRevision?: number) => ({
  type,
  payload,
  commandId: `cmd-${(counter += 1)}`,
  issuedAt: '2026-07-18T18:40:00-04:00',
  ...(expectedRevision === undefined ? {} : { expectedRevision })
});

const send = async (app: ReturnType<typeof createApp>, body: unknown, expectStatus = 200) => {
  const response = await request(app)
    .post('/api/commands')
    .send(body as object)
    .expect(expectStatus);
  return response.body as CommandResponse;
};

const ok = (response: CommandResponse) => {
  if (!response.ok)
    throw new Error(`expected success, got ${response.error.code}: ${response.error.message}`);
  return response;
};

describe('health and provenance', () => {
  it('reports mock chiefs when no Gemini key is present', async () => {
    const response = await request(mockApp()).get('/health').expect(200);
    expect(response.body).toMatchObject({
      mode: 'deterministic-mock',
      reasoning: { provider: 'mock', model: 'deterministic-mock', configured: false }
    });
  });

  it('reports Gemini chiefs when a key is present', async () => {
    const response = await request(liveApp()).get('/health').expect(200);
    expect(response.body).toMatchObject({
      mode: 'gemini-live',
      reasoning: { provider: 'gemini', model: 'gemini-2.0-flash', configured: true }
    });
  });

  it('never exposes a credential in any response body', async () => {
    const app = liveApp(geminiReply('{"summary":"s","action":"a","confidence":0.8}'));
    for (const path of ['/health', '/api/scenario', '/api/recommendations']) {
      const response = await request(app).get(path).expect(200);
      expect(JSON.stringify(response.body)).not.toContain(geminiConfig.apiKey);
    }
  });
});

describe('the full eight-step demo over HTTP', () => {
  it('runs flood -> bridge -> disconnect -> queue -> reconnect -> sync -> propose -> approve -> reset', async () => {
    counter = 0;
    const app = mockApp();
    const zone = 'zone-south-side';

    // 1. flood
    const flood = ok(
      await send(
        app,
        command('scenario.trigger_flood', { intensity: 'severe', zoneIds: ['zone-oakland'] })
      )
    );
    expect(flood.revision).toBe(1);
    expect((flood.data as { raisedIncidents: unknown[] }).raisedIncidents).toHaveLength(2);

    // 2. bridge closure
    const bridge = ok(
      await send(
        app,
        command('route.close_bridge', { bridgeId: 'bridge-birmingham', closed: true })
      )
    );
    expect((bridge.data as { closedRouteIds: string[] }).closedRouteIds).toContain(
      'route-mercy-south'
    );

    // 3. zone disconnect
    ok(
      await send(app, command('zone.set_connectivity', { zoneId: zone, connectivity: 'offline' }))
    );

    // 4. offline report is queued, NOT added to incident state
    const before = (await request(app).get('/api/scenario').expect(200)).body.incidents.length;
    const queued = ok(
      await send(
        app,
        command('report.submit', {
          clientReportId: 'rep-1',
          zoneId: zone,
          body: 'Elderly man trapped in a stalled van, water rising.',
          capturedAt: '2026-07-18T18:46:00-04:00'
        })
      )
    );
    expect((queued.data as { queuedOffline: boolean }).queuedOffline).toBe(true);
    const afterQueue = (await request(app).get('/api/scenario').expect(200)).body;
    expect(afterQueue.incidents).toHaveLength(before);
    expect(afterQueue.reports).toHaveLength(1);

    // 5. reconnect and sync
    const reconnect = ok(
      await send(app, command('zone.set_connectivity', { zoneId: zone, connectivity: 'online' }))
    );
    expect((reconnect.data as { syncableReportIds: string[] }).syncableReportIds).toEqual([
      'rep-1'
    ]);
    const synced = ok(
      await send(
        app,
        command('report.sync', {
          reports: [
            {
              clientReportId: 'rep-1',
              zoneId: zone,
              body: 'Elderly man trapped in a stalled van, water rising.',
              capturedAt: '2026-07-18T18:46:00-04:00'
            }
          ]
        })
      )
    );
    expect((synced.data as { applied: unknown[] }).applied).toHaveLength(1);
    expect((await request(app).get('/api/scenario')).body.incidents).toHaveLength(before + 1);

    // 6. propose
    const proposal = ok(await send(app, command('plan.propose', {})));
    const plan = (
      proposal.data as { plan: { id: string; rationale: string; forecast: { synthetic: boolean } } }
    ).plan;
    expect(plan.rationale.length).toBeGreaterThan(20);
    expect(plan.forecast.synthetic).toBe(true);

    // 7. approve
    const approved = ok(await send(app, command('plan.approve', { planId: plan.id })));
    const assigned = (approved.data as { assignedResourceIds: string[] }).assignedResourceIds;
    expect(assigned.length).toBeGreaterThan(0);
    const afterApproval = (await request(app).get('/api/scenario')).body;
    for (const id of assigned) {
      expect(afterApproval.resources.find((r: { id: string }) => r.id === id).status).toBe(
        'assigned'
      );
    }

    // facility mix survives the whole sequence
    const mix = (kind: string) =>
      afterApproval.facilities.filter((f: { kind: string }) => f.kind === kind).length;
    expect(mix('hospital')).toBe(3);
    expect(mix('fire_house')).toBeGreaterThanOrEqual(3);
    expect(mix('police_hub')).toBe(2);
    expect(mix('rescue_center')).toBe(2);

    // 8. reset
    ok(await send(app, command('scenario.reset', {})));
    const afterReset = (await request(app).get('/api/scenario')).body;
    expect(afterReset).toEqual(pittsburghFloodScenario);
    expect(afterReset.revision).toBe(0);
  });
});

describe('safety properties over HTTP', () => {
  it('never double-books a resource', async () => {
    const app = mockApp();
    const first = ok(await send(app, command('plan.propose', {})));
    const firstId = (first.data as { plan: { id: string } }).plan.id;
    ok(await send(app, command('plan.approve', { planId: firstId })));

    // once the first plan is approved there may be nothing left to allocate,
    // so a second proposal is legitimately allowed to fail as infeasible
    const secondRaw = await request(app).post('/api/commands').send(command('plan.propose', {}));
    const second = secondRaw.body as CommandResponse;
    if (second.ok) {
      const planId = (second.data as { plan: { id: string } }).plan.id;
      await request(app).post('/api/commands').send(command('plan.approve', { planId }));
    }
    const scenario = (await request(app).get('/api/scenario')).body;
    const held = scenario.assignments
      .filter((a: { status: string }) => a.status === 'approved' || a.status === 'dispatched')
      .flatMap((a: { resourceIds: string[] }) => a.resourceIds);
    expect(new Set(held).size).toBe(held.length);
  });

  it('excludes closed routes from a new plan', async () => {
    const app = mockApp();
    ok(
      await send(app, command('route.close_bridge', { bridgeId: 'bridge-hot-metal', closed: true }))
    );
    const proposal = ok(await send(app, command('plan.propose', {})));
    const plan = (
      proposal.data as { plan: { assignments: { incidentId: string; resourceIds: string[] }[] } }
    ).plan;
    const parkway = plan.assignments.find((a) => a.incidentId === 'inc-parkway');
    // boat-5 lives at r-east, whose only modeled route to inc-parkway is now closed
    expect(parkway?.resourceIds ?? []).not.toContain('boat-5');
  });

  it('rejects a stale plan with 409', async () => {
    const app = mockApp();
    const proposal = ok(await send(app, command('plan.propose', {})));
    const planId = (proposal.data as { plan: { id: string } }).plan.id;
    ok(
      await send(
        app,
        command('zone.set_connectivity', { zoneId: 'zone-east', connectivity: 'degraded' })
      )
    );

    const failure = await send(app, command('plan.approve', { planId }), 409);
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.error.code).toBe('plan_stale');
  });

  it('synchronises a report exactly once across retries', async () => {
    const app = mockApp();
    const zone = 'zone-south-side';
    ok(
      await send(app, command('zone.set_connectivity', { zoneId: zone, connectivity: 'offline' }))
    );
    const payload = {
      reports: [
        {
          clientReportId: 'rep-x',
          zoneId: zone,
          body: 'Two people trapped.',
          capturedAt: '2026-07-18T18:46:00-04:00'
        }
      ]
    };
    ok(await send(app, command('report.submit', payload.reports[0])));
    ok(await send(app, command('zone.set_connectivity', { zoneId: zone, connectivity: 'online' })));
    ok(await send(app, command('report.sync', payload)));

    const afterFirst = (await request(app).get('/api/scenario')).body;
    const retry = ok(await send(app, command('report.sync', payload)));
    expect((retry.data as { applied: unknown[]; duplicates: unknown[] }).applied).toHaveLength(0);
    expect((retry.data as { duplicates: unknown[] }).duplicates).toHaveLength(1);

    const afterRetry = (await request(app).get('/api/scenario')).body;
    expect(afterRetry.incidents).toHaveLength(afterFirst.incidents.length);
    expect(afterRetry.events).toHaveLength(afterFirst.events.length);
  });

  it('treats a replayed commandId as a no-op', async () => {
    const app = mockApp();
    const cmd = command('scenario.trigger_flood', {
      intensity: 'moderate',
      zoneIds: ['zone-east']
    });
    const first = ok(await send(app, cmd));
    const replay = ok(await send(app, cmd));
    expect(replay.duplicate).toBe(true);
    expect(replay.revision).toBe(first.revision);
    expect(replay.events).toEqual([]);
  });

  it('rejects a malformed command with a CommandResponse, not a crash', async () => {
    const app = mockApp();
    const failure = await send(
      app,
      { type: 'scenario.explode', commandId: 'x', issuedAt: 'now', payload: {} },
      400
    );
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.error.code).toBe('validation_failed');
  });

  it('honours expectedRevision with a 409 conflict', async () => {
    const app = mockApp();
    const failure = await send(app, command('plan.propose', {}, 99), 409);
    if (!failure.ok) expect(failure.error.code).toBe('revision_conflict');
  });
});

describe('polling', () => {
  it('reports upToDate at the current revision and a delta after a change', async () => {
    const app = mockApp();
    const initial = await request(app).get('/api/world-state').expect(200);
    expect(initial.body.upToDate).toBe(false);
    expect(initial.body.scenario).toBeDefined();
    expect(initial.body.revision).toBe(0);

    const same = await request(app).get('/api/world-state?since=0').expect(200);
    expect(same.body.upToDate).toBe(true);
    expect(same.body.events).toEqual([]);

    ok(
      await send(
        app,
        command('scenario.trigger_flood', { intensity: 'moderate', zoneIds: ['zone-east'] })
      )
    );
    const delta = await request(app).get('/api/world-state?since=0').expect(200);
    expect(delta.body.upToDate).toBe(false);
    expect(delta.body.revision).toBe(1);
    expect(delta.body.events.length).toBeGreaterThan(0);
    expect(delta.body.events.every((e: { revision: number }) => e.revision > 0)).toBe(true);
  });

  it('sends the full scenario when the cursor is ahead of the world, e.g. after a reset', async () => {
    const app = mockApp();
    ok(
      await send(
        app,
        command('scenario.trigger_flood', { intensity: 'moderate', zoneIds: ['zone-east'] })
      )
    );
    ok(await send(app, command('scenario.reset', {})));
    const response = await request(app).get('/api/world-state?since=5').expect(200);
    expect(response.body.upToDate).toBe(false);
    expect(response.body.scenario).toBeDefined();
    expect(response.body.revision).toBe(0);
  });

  it('rejects a non-numeric cursor', async () => {
    await request(mockApp()).get('/api/world-state?since=abc').expect(400);
  });
});

describe('Gemini chiefs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const validChief =
    '{"summary":"Hold one boat in reserve","action":"Stage EAST-5 at r-east.","confidence":0.84,"relatedIncidentId":"inc-parkway"}';

  it('serves five validated recommendations attributed to Gemini', async () => {
    const response = await request(liveApp(geminiReply(validChief)))
      .get('/api/recommendations')
      .expect(200);
    expect(response.body.items).toHaveLength(5);
    expect(response.body.revision).toBe(0);
    for (const item of response.body.items) {
      expect(item.source).toMatchObject({
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        degraded: false
      });
      expect(item.analyzedRevision).toBe(0);
      expect(item.recommendation.status).toBe('pending');
      expect(item.recommendation.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('drops an incident id the model invented', async () => {
    const app = liveApp(
      geminiReply(
        '{"summary":"s","action":"a","confidence":0.5,"relatedIncidentId":"inc-imaginary"}'
      )
    );
    const response = await request(app).get('/api/recommendations/medical_chief').expect(200);
    expect(response.body.recommendation.relatedIncidentId).toBeUndefined();
    expect(response.body.source.provider).toBe('gemini');
  });

  it('falls back to the mock with visible provenance when Gemini errors', async () => {
    const unauthorized: FetchLike = async () => new Response('API key not valid', { status: 401 });
    const response = await request(liveApp(unauthorized)).get('/api/recommendations').expect(200);
    expect(response.body.items).toHaveLength(5);
    for (const item of response.body.items) {
      expect(item.source.provider).toBe('mock');
      expect(item.source.degraded).toBe(true);
      expect(item.source.warning).toContain('401');
    }
  });

  it('falls back when Gemini returns unparseable output', async () => {
    const response = await request(liveApp(geminiReply('I cannot help with that.')))
      .get('/api/recommendations')
      .expect(200);
    expect(response.body.items[0].source).toMatchObject({ provider: 'mock', degraded: true });
  });

  it('falls back when Gemini blocks the prompt', async () => {
    const blocked: FetchLike = async () =>
      new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 });
    const response = await request(liveApp(blocked)).get('/api/recommendations').expect(200);
    expect(response.body.items[0].source.warning).toContain('SAFETY');
  });

  it('does not call the model again while the revision is unchanged', async () => {
    const calls = vi.fn(geminiReply(validChief));
    const app = liveApp(calls as unknown as FetchLike);

    await request(app).get('/api/recommendations').expect(200);
    expect(calls).toHaveBeenCalledTimes(5); // one per chief

    // repeated polling at the same revision must not reach the model
    for (let i = 0; i < 4; i += 1) {
      const again = await request(app).get('/api/recommendations').expect(200);
      expect(again.body.cached).toBe(true);
    }
    expect(calls).toHaveBeenCalledTimes(5);

    // a command advances the revision and retires the cached advice
    ok(
      await send(
        app,
        command('scenario.trigger_flood', { intensity: 'moderate', zoneIds: ['zone-east'] })
      )
    );
    const fresh = await request(app).get('/api/recommendations').expect(200);
    expect(fresh.body.cached).toBe(false);
    expect(fresh.body.revision).toBe(1);
    expect(calls).toHaveBeenCalledTimes(10);
  });

  it('parses a field report through Gemini with provenance', async () => {
    const app = liveApp(
      geminiReply(
        '{"title":"Van submerged with occupant","description":"Water rising around a stalled van.","severity":"critical"}'
      )
    );
    const response = await request(app)
      .post('/api/reports/parse')
      .send({ report: 'Elderly man stuck in a stalled van on Carson Street' })
      .expect(200);
    expect(response.body.incident.severity).toBe('critical');
    expect(response.body.source).toMatchObject({ provider: 'gemini', degraded: false });
  });
});
