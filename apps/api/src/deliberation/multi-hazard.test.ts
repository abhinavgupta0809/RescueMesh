import { createFixedClock, SimulationEngine } from '@rescuemesh/engine';
import {
  DISASTER_KINDS,
  DISASTER_TEMPLATES,
  MAX_DISASTERS_PER_EXERCISE,
  pittsburghFloodScenario,
  validateExercise,
  type DisasterKind,
  type DeliberationSession
} from '@rescuemesh/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createAdapters } from '../adapters/index.js';
import { GeminiClient, type FetchLike } from '../adapters/gemini.js';
import type { GeminiConfig } from '../config.js';
import { World } from '../world.js';
import { DELIBERATION_DEFAULTS, DeliberationOrchestrator } from './orchestrator.js';

const config: GeminiConfig = {
  apiKey: 'test-key-not-a-real-credential',
  baseUrl: 'https://example.invalid/v1beta',
  model: 'gemini-3.6-flash',
  timeoutMs: 5_000,
  maxOutputTokens: 4_096,
  temperature: 0.2
};
const POSITION = {
  situationSummary: 'Multiple hazards active.',
  topPriorities: ['Life safety'],
  risks: ['Limited reserve'],
  proposedActions: ['Request a plan'],
  confidence: 0.85
};
const RESPONSE = {
  agreements: ['Agreed'],
  objections: [],
  revisedPriority: 'Life safety first',
  recommendation: 'Commit the nearest units',
  confidence: 0.86
};
const BRIEF = {
  situationSummary: 'Multi-hazard exercise under way.',
  pointsOfAgreement: ['Life safety first'],
  unresolvedDisputes: [],
  orderedPriorities: ['Life safety'],
  proposedActions: ['Request a plan'],
  rationale: 'Converged on life safety across both hazards.',
  confidence: 0.88
};
const isReview = (s: string) => s.includes('read the other chiefs');
const isInitial = (s: string) => !isReview(s) && s.includes('opening position');

const gemini = () => {
  let calls = 0;
  const prompts: { system: string; user: string }[] = [];
  const impl: FetchLike = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init.body)) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
    };
    const system = body.systemInstruction.parts[0]?.text ?? '';
    prompts.push({ system, user: body.contents[0]?.parts[0]?.text ?? '' });
    const text = isReview(system)
      ? JSON.stringify(RESPONSE)
      : isInitial(system)
        ? JSON.stringify(POSITION)
        : JSON.stringify(BRIEF);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  return { impl, count: () => calls, prompts: () => prompts };
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
  const app = createApp({ adapters: createAdapters(null), world, deliberation: orchestrator });
  return { app, world, orchestrator };
};

const ZONES = pittsburghFloodScenario.zones.map((z) => z.id);
const start = (app: ReturnType<typeof createApp>, body: object) =>
  request(app).post('/api/simulations').send(body);
const settle = async (app: ReturnType<typeof createApp>, id: string) => {
  for (let i = 0; i < 100; i += 1) {
    const r = await request(app).get(`/api/simulations/${id}`).expect(200);
    const s = r.body.session as DeliberationSession;
    if (['ready', 'degraded', 'stale', 'failed'].includes(s.status)) return s;
    await new Promise((r2) => setTimeout(r2, 20));
  }
  throw new Error('never settled');
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('every disaster in every zone', () => {
  it('supports each kind in Downtown', async () => {
    for (const kind of DISASTER_KINDS) {
      const { app, world } = build();
      const r = await start(app, {
        disasters: [{ kind, zoneId: 'zone-downtown', severity: 'high' }]
      }).expect(201);
      expect((r.body.session as DeliberationSession).scenarioRevision).toBe(1);
      const raised = world.scenario.incidents.filter((i) => i.id.startsWith('inc-exr-'));
      expect(raised).toHaveLength(1);
      expect(raised[0]?.requiredCapabilities).toEqual(
        DISASTER_TEMPLATES[kind].requiredCapabilities
      );
      const zone = world.scenario.zones.find((z) => z.id === 'zone-downtown');
      expect(zone?.incidentIds).toContain(raised[0]?.id);
    }
  });

  it('supports each kind in every valid zone', async () => {
    for (const kind of DISASTER_KINDS) {
      for (const zoneId of ZONES) {
        const { app, world } = build();
        await start(app, { disasters: [{ kind, zoneId, severity: 'moderate' }] }).expect(201);
        expect(world.scenario.revision).toBe(1);
        const raised = world.scenario.incidents.filter((i) => i.id.startsWith('inc-exr-'));
        expect(raised, `${kind} in ${zoneId}`).toHaveLength(1);
      }
    }
  });
});

describe('two-disaster exercises', () => {
  const pairs: [DisasterKind, DisasterKind][] = [
    ['flash_flood', 'structural_fire'],
    ['flash_flood', 'multi_vehicle_collision'],
    ['structural_fire', 'multi_vehicle_collision']
  ];

  it.each(pairs)('applies %s + %s in different zones as one revision', async (a, b) => {
    const { app, world } = build();
    const r = await start(app, {
      disasters: [
        { kind: a, zoneId: 'zone-downtown', severity: 'high' },
        { kind: b, zoneId: 'zone-east', severity: 'moderate' }
      ]
    }).expect(201);
    expect(world.scenario.revision).toBe(1);
    expect((r.body.session as DeliberationSession).scenarioRevision).toBe(1);
    expect(world.scenario.incidents.filter((i) => i.id.startsWith('inc-exr-'))).toHaveLength(2);
  });

  it('allows two different kinds in the SAME zone', async () => {
    const { app, world } = build();
    await start(app, {
      disasters: [
        { kind: 'structural_fire', zoneId: 'zone-oakland', severity: 'high' },
        { kind: 'multi_vehicle_collision', zoneId: 'zone-oakland', severity: 'moderate' }
      ]
    }).expect(201);
    expect(world.scenario.revision).toBe(1);
    const zone = world.scenario.zones.find((z) => z.id === 'zone-oakland');
    expect(zone?.incidentIds.filter((i) => i.startsWith('inc-exr-'))).toHaveLength(2);
  });

  it('allows the same kind in two DIFFERENT zones', async () => {
    const { app, world } = build();
    await start(app, {
      disasters: [
        { kind: 'structural_fire', zoneId: 'zone-downtown', severity: 'high' },
        { kind: 'structural_fire', zoneId: 'zone-east', severity: 'high' }
      ]
    }).expect(201);
    expect(world.scenario.revision).toBe(1);
    expect(world.scenario.incidents.filter((i) => i.id.startsWith('inc-exr-'))).toHaveLength(2);
  });

  it('emits one auditable event per disaster plus one exercise event', async () => {
    const { app, world } = build();
    await start(app, {
      disasters: [
        { kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'high' },
        { kind: 'structural_fire', zoneId: 'zone-east', severity: 'high' }
      ]
    }).expect(201);
    const events = world.scenario.events.filter((e) => (e.revision ?? 0) === 1);
    expect(events.filter((e) => e.type === 'incident_reported')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'exercise_started')).toHaveLength(1);
  });
});

describe('capability requirements match the seed vocabulary', () => {
  const served = new Set(pittsburghFloodScenario.resources.flatMap((r) => r.capabilities));

  it.each(DISASTER_KINDS)('%s requires only capabilities some resource carries', (kind) => {
    for (const capability of DISASTER_TEMPLATES[kind].requiredCapabilities) {
      expect(served, `${kind} requires unservable ${capability}`).toContain(capability);
    }
  });

  it('gives the three kinds meaningfully different demands', () => {
    const sets = DISASTER_KINDS.map((k) => DISASTER_TEMPLATES[k].requiredCapabilities.join(','));
    expect(new Set(sets).size).toBe(3);
    expect(DISASTER_TEMPLATES.flash_flood.requiredCapabilities).toContain('swift-water-rescue');
    expect(DISASTER_TEMPLATES.structural_fire.requiredCapabilities).toContain('fire-suppression');
    expect(DISASTER_TEMPLATES.multi_vehicle_collision.requiredCapabilities).toContain(
      'traffic-control'
    );
    // no invented extrication capability
    expect(DISASTER_TEMPLATES.multi_vehicle_collision.requiredCapabilities).not.toContain(
      'extrication'
    );
  });

  it('surfaces shortfalls when resources cannot cover the demand', async () => {
    const { app, world } = build();
    await start(app, {
      disasters: [
        { kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'critical' },
        { kind: 'structural_fire', zoneId: 'zone-east', severity: 'critical' }
      ]
    }).expect(201);
    const plan = world.execute({
      type: 'plan.propose',
      commandId: 'p1',
      issuedAt: '2026-07-18T18:40:00-04:00',
      payload: {}
    });
    if (!plan.ok || plan.type !== 'plan.propose') throw new Error('propose failed');
    expect(plan.data.plan.shortfalls.length).toBeGreaterThan(0);
  });

  it('slows exactly one modeled route for a collision, never closes one', async () => {
    const { app, world } = build();
    const before = world.scenario.routes.map((r) => `${r.id}:${r.status}`);
    await start(app, {
      disasters: [{ kind: 'multi_vehicle_collision', zoneId: 'zone-downtown', severity: 'high' }]
    }).expect(201);
    const after = world.scenario.routes;
    expect(after.some((r) => r.status === 'closed' && !before.includes(`${r.id}:closed`))).toBe(
      false
    );
    const changed = after.filter((r) => !before.includes(`${r.id}:${r.status}`));
    expect(changed.length).toBeLessThanOrEqual(1);
    for (const route of changed) expect(route.status).toBe('slow');
  });
});

describe('rejections — the exercise is refused whole', () => {
  const reject = async (disasters: unknown, code: string) => {
    const { app, world } = build();
    const before = world.scenario;
    const r = await start(app, { disasters }).expect(400);
    expect(r.body.error).toBe(code);
    expect(world.scenario).toEqual(before);
  };

  it('zero disasters', () => reject([], 'no_disasters'));
  it('more than two', () =>
    reject(
      [
        { kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'high' },
        { kind: 'structural_fire', zoneId: 'zone-east', severity: 'high' },
        { kind: 'multi_vehicle_collision', zoneId: 'zone-oakland', severity: 'high' }
      ],
      'too_many_disasters'
    ));
  it('unknown kind', () =>
    reject([{ kind: 'meteor_strike', zoneId: 'zone-downtown', severity: 'high' }], 'unknown_kind'));
  it('unknown zone', () =>
    reject([{ kind: 'flash_flood', zoneId: 'zone-atlantis', severity: 'high' }], 'unknown_zone'));
  it('invalid severity', () =>
    reject(
      [{ kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'apocalyptic' }],
      'invalid_severity'
    ));
  it('duplicate identical kind and zone', () =>
    reject(
      [
        { kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'high' },
        { kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'low' }
      ],
      'duplicate_disaster'
    ));

  it('rejects sending both disasters and step', async () => {
    const { app } = build();
    const r = await start(app, {
      disasters: [{ kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'high' }],
      step: 'initial_flooding'
    }).expect(400);
    expect(r.body.error).toBe('ambiguous_request');
  });

  it('validateExercise refuses a non-array payload', () => {
    const v = validateExercise('flood', pittsburghFloodScenario);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.rejection.code).toBe('invalid_payload');
  });

  it('accepts exactly the documented maximum', () => {
    const v = validateExercise(
      [
        { kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'high' },
        { kind: 'structural_fire', zoneId: 'zone-east', severity: 'low' }
      ],
      pittsburghFloodScenario
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.disasters).toHaveLength(MAX_DISASTERS_PER_EXERCISE);
  });
});

describe('deliberation over the complete exercise', () => {
  const twoHazards = {
    disasters: [
      { kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'critical' },
      { kind: 'structural_fire', zoneId: 'zone-east', severity: 'high' }
    ],
    requestId: 'mh-1'
  };

  it('all five chiefs see both hazards at the frozen revision', async () => {
    const g = gemini();
    const { app, world } = build(g.impl);
    const started = await start(app, twoHazards).expect(201);
    const session = await settle(app, (started.body.session as DeliberationSession).sessionId);

    expect(session.status).toBe('ready');
    expect(session.scenarioRevision).toBe(1);
    expect(g.count()).toBe(11);

    const ids = world.scenario.incidents
      .filter((i) => i.id.startsWith('inc-exr-'))
      .map((i) => i.id);
    expect(ids).toHaveLength(2);
    // every initial-round prompt carries both new incidents
    const initial = g.prompts().filter((p) => isInitial(p.system));
    expect(initial).toHaveLength(5);
    for (const prompt of initial) {
      for (const id of ids) expect(`${prompt.system}\n${prompt.user}`).toContain(id);
    }
  });

  it('deliberation starts only after BOTH disasters are applied', async () => {
    const g = gemini();
    const { app, world } = build(g.impl);
    const started = await start(app, twoHazards).expect(201);
    // the world already holds both before the session leaves 'triggered'
    expect(world.scenario.incidents.filter((i) => i.id.startsWith('inc-exr-'))).toHaveLength(2);
    expect(world.scenario.revision).toBe(1);
    await settle(app, (started.body.session as DeliberationSession).sessionId);
    expect(world.scenario.revision).toBe(1);
  });

  it('a duplicate requestId adds no incidents and no model calls', async () => {
    const g = gemini();
    const { app, world } = build(g.impl);
    const first = await start(app, twoHazards).expect(201);
    await settle(app, (first.body.session as DeliberationSession).sessionId);
    const incidents = world.scenario.incidents.length;
    const revision = world.scenario.revision;
    const calls = g.count();

    const second = await start(app, twoHazards).expect(200);
    expect(second.body.duplicate).toBe(true);
    expect(world.scenario.incidents).toHaveLength(incidents);
    expect(world.scenario.revision).toBe(revision);
    expect(g.count()).toBe(calls);
  });

  it('polling stays at eleven calls', async () => {
    const g = gemini();
    const { app } = build(g.impl);
    const started = await start(app, twoHazards).expect(201);
    const id = (started.body.session as DeliberationSession).sessionId;
    await settle(app, id);
    for (let i = 0; i < 5; i += 1) await request(app).get(`/api/simulations/${id}`).expect(200);
    expect(g.count()).toBe(11);
  });

  it('a world change during deliberation makes the session stale', async () => {
    const g = gemini();
    const { app, world } = build(g.impl);
    const started = await start(app, twoHazards).expect(201);
    const id = (started.body.session as DeliberationSession).sessionId;
    await settle(app, id);
    world.execute({
      type: 'zone.set_connectivity',
      commandId: 'move',
      issuedAt: '2026-07-18T18:40:00-04:00',
      payload: { zoneId: 'zone-east', connectivity: 'degraded' }
    });
    const after = await request(app).get(`/api/simulations/${id}`).expect(200);
    expect((after.body.session as DeliberationSession).status).toBe('stale');
  });

  it('replays deterministically', async () => {
    const run = async () => {
      const { app, world } = build();
      await start(app, {
        disasters: [
          { kind: 'multi_vehicle_collision', zoneId: 'zone-downtown', severity: 'high' },
          { kind: 'structural_fire', zoneId: 'zone-oakland', severity: 'moderate' }
        ]
      }).expect(201);
      return world.scenario;
    };
    expect(await run()).toEqual(await run());
  });
});

describe('reset clears a multi-hazard exercise', () => {
  it('removes flood, fire and collision incidents and returns to revision zero', async () => {
    const g = gemini();
    const { app, world } = build(g.impl);
    const a = await start(app, {
      disasters: [
        { kind: 'flash_flood', zoneId: 'zone-downtown', severity: 'critical' },
        { kind: 'multi_vehicle_collision', zoneId: 'zone-east', severity: 'high' }
      ],
      requestId: 'reset-me'
    }).expect(201);
    const id = (a.body.session as DeliberationSession).sessionId;
    await settle(app, id);
    expect(world.scenario.incidents.filter((i) => i.id.startsWith('inc-exr-'))).toHaveLength(2);

    await request(app)
      .post('/api/commands')
      .send({
        type: 'scenario.reset',
        commandId: 'reset-1',
        issuedAt: '2026-07-18T18:40:00-04:00',
        payload: {}
      })
      .expect(200);

    expect(world.scenario).toEqual(pittsburghFloodScenario);
    expect(world.scenario.revision).toBe(0);
    expect(world.scenario.incidents.filter((i) => i.id.startsWith('inc-exr-'))).toHaveLength(0);
    await request(app).get(`/api/simulations/${id}`).expect(404);
  });
});

describe('existing scripted flow still works', () => {
  it('accepts a step-based simulation unchanged', async () => {
    const g = gemini();
    const { app, world } = build(g.impl);
    const r = await start(app, { step: 'initial_flooding' }).expect(201);
    expect(world.scenario.revision).toBe(1);
    const s = await settle(app, (r.body.session as DeliberationSession).sessionId);
    expect(s.status).toBe('ready');
    expect(s.scenarioStep).toBe('initial_flooding');
  });

  it('accepts a simulation with neither disasters nor step', async () => {
    const { app, world } = build();
    await start(app, {}).expect(201);
    expect(world.scenario.revision).toBe(0);
  });
});
