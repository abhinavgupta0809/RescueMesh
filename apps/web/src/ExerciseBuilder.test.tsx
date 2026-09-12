import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DISASTER_KINDS,
  MAX_DISASTERS_PER_EXERCISE,
  pittsburghFloodScenario,
  type DeliberationSession,
  type DisasterKind,
  type DisasterSpecification
} from '@rescuemesh/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient, makeCommand } from './api-client';
import {
  ExerciseBuilder,
  addSecondDisaster,
  defaultExercise,
  removeSecondDisaster,
  validateExerciseBuilder
} from './ExerciseBuilder';
import { createMockClient, createSeed } from './mock-client';
import { DeliberationRunner } from './deliberation-runner';

const zones = pittsburghFloodScenario.zones;
const spec = (
  kind: DisasterKind,
  zoneId = 'zone-downtown',
  severity: DisasterSpecification['severity'] = 'high'
): DisasterSpecification => ({ kind, zoneId, severity });

const renderBuilder = (disasters = defaultExercise(), disabled = false) =>
  renderToStaticMarkup(
    createElement(ExerciseBuilder, {
      scenario: pittsburghFloodScenario,
      disasters,
      disabled,
      starting: disabled,
      onChange: () => {},
      onSubmit: () => {}
    })
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('zone-selectable exercise builder', () => {
  it('defaults to the rehearsed high flash flood in Oakland', () => {
    expect(defaultExercise()).toEqual([spec('flash_flood', 'zone-oakland')]);
    const html = renderBuilder();
    expect(html).toContain('Synthetic exercise builder');
    expect(html).toContain('Flash flood');
    expect(html).toContain('Oakland / Bates Street');
    expect(html).toContain('aria-label="Disaster 1 type"');
    expect(html).toContain('aria-label="Disaster 1 zone"');
    expect(html).toContain('aria-label="Disaster 1 severity"');
  });

  it.each([
    spec('flash_flood'),
    spec('structural_fire', 'zone-oakland'),
    spec('multi_vehicle_collision', 'zone-east')
  ])('renders selectable labels, zones and accessible controls for $kind', (disaster) => {
    const html = renderBuilder([disaster]);
    for (const label of ['Flash flood', 'Structural fire', 'Multi-vehicle collision'])
      expect(html).toContain(label);
    for (const zone of zones) expect(html).toContain(zone.name);
    expect(html).toContain(
      { flash_flood: '≋', structural_fire: '🔥', multi_vehicle_collision: '⚠' }[disaster.kind]
    );
    expect(html).toContain(
      `disaster-fields ${{ flash_flood: 'flood', structural_fire: 'fire', multi_vehicle_collision: 'collision' }[disaster.kind]}`
    );
    expect(html).toContain('type="submit"');
    expect(html).toContain('Add second disaster');
  });

  it('adds and removes Disaster 2 and never creates a third', () => {
    const one = defaultExercise();
    const two = addSecondDisaster(one);
    expect(two).toHaveLength(2);
    expect(two[1]).toEqual(spec('structural_fire'));
    expect(addSecondDisaster(two)).toEqual(two);
    expect(two.length).toBe(MAX_DISASTERS_PER_EXERCISE);
    expect(
      validateExerciseBuilder(
        [...two, spec('multi_vehicle_collision', 'zone-east')],
        pittsburghFloodScenario
      ).form
    ).toContain('at most 2');
    expect(removeSecondDisaster(two)).toEqual(one);
    const html = renderBuilder(two);
    expect(html).toContain('Remove Disaster 2');
    expect(html).not.toContain('Add second disaster');
  });

  it('shows concise duplicate validation beside the second zone and disables submit', () => {
    const disasters = [spec('flash_flood'), spec('flash_flood', 'zone-downtown', 'low')];
    expect(validateExerciseBuilder(disasters, pittsburghFloodScenario)).toEqual({
      fields: { 1: { zoneId: 'Choose a different disaster type or zone.' } }
    });
    const html = renderBuilder(disasters);
    expect(html).toContain('Choose a different disaster type or zone.');
    expect(html).toContain('aria-describedby="disaster-1-zone-error"');
    expect(html).toMatch(/<button class="primary" type="submit" disabled/);
  });

  it('disables native fields and the single Simulate submit while starting', () => {
    const html = renderBuilder(defaultExercise(), true);
    expect(html).toContain('<fieldset class="disaster-fields flood" disabled=""');
    expect(html).toContain('Starting…');
    expect(html).toMatch(/<button class="primary" type="submit" disabled/);
  });
});

describe('local mock atomic exercise parity', () => {
  it('supports every disaster in every authoritative zone', async () => {
    for (const kind of DISASTER_KINDS) {
      for (const zone of zones) {
        const client = createMockClient();
        const session = await client.startSimulation({ disasters: [spec(kind, zone.id)] });
        const world = await client.scenario();
        expect(session.scenarioRevision, `${kind} in ${zone.id}`).toBe(1);
        expect(world.revision).toBe(1);
        expect(world.zones.find((item) => item.id === zone.id)?.incidentIds).toContain(
          world.incidents.at(-1)?.id
        );
      }
    }
  });

  it.each([
    ['flash_flood', 'structural_fire'],
    ['flash_flood', 'multi_vehicle_collision'],
    ['structural_fire', 'multi_vehicle_collision']
  ] as [DisasterKind, DisasterKind][])(
    'applies %s plus %s in one revision',
    async (first, second) => {
      const client = createMockClient();
      const seed = await client.scenario();
      const session = await client.startSimulation({
        disasters: [spec(first, 'zone-downtown'), spec(second, 'zone-east', 'moderate')]
      });
      const world = await client.scenario();
      expect(session.scenarioRevision).toBe(1);
      expect(world.incidents).toHaveLength(seed.incidents.length + 2);
      expect(world.events.filter((event) => event.type === 'exercise_started')).toHaveLength(1);
      expect(
        world.events.filter((event) => event.type === 'incident_reported').length -
          seed.events.filter((event) => event.type === 'incident_reported').length
      ).toBe(2);
    }
  );

  it('allows different disasters in the same zone and rejects an identical kind/zone pair whole', async () => {
    const client = createMockClient();
    await client.startSimulation({
      disasters: [
        spec('structural_fire', 'zone-oakland'),
        spec('multi_vehicle_collision', 'zone-oakland')
      ]
    });
    expect((await client.scenario()).revision).toBe(1);

    const invalid = createMockClient();
    await expect(
      invalid.startSimulation({
        disasters: [spec('flash_flood'), spec('flash_flood', 'zone-downtown', 'low')]
      })
    ).rejects.toThrow('already selected');
    expect(await invalid.scenario()).toEqual(createSeed());
  });

  it('is repeatable after complete reset and clears the prior frozen session', async () => {
    const client = createMockClient();
    const request = {
      disasters: [
        spec('flash_flood', 'zone-north-shore'),
        spec('multi_vehicle_collision', 'zone-south-side', 'moderate')
      ],
      requestId: 'repeatable-exercise'
    };
    const first = await client.startSimulation(request);
    const firstWorld = await client.scenario();
    await client.command(makeCommand('plan.propose', {}));
    await client.command(makeCommand('scenario.reset', {}));
    expect(await client.scenario()).toEqual(createSeed());
    await expect(client.simulation(first.sessionId)).rejects.toThrow('Unknown session');
    const second = await client.startSimulation(request);
    expect(await client.scenario()).toEqual(firstWorld);
    expect(second.scenarioRevision).toBe(first.scenarioRevision);
  });
});

describe('single atomic request and stable request ID', () => {
  beforeEach(() => vi.useFakeTimers());

  it('protects duplicate clicks and deliberates on the one returned frozen revision', async () => {
    const client = createMockClient();
    const start = vi.spyOn(client, 'startSimulation');
    const runner = new DeliberationRunner(() => {});
    const disasters = [spec('flash_flood'), spec('structural_fire', 'zone-oakland')];
    const first = runner.start(client, { disasters }, async () => {});
    await runner.start(client, { disasters }, async () => {});
    await first;
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0].disasters).toEqual(disasters);
    expect(start.mock.calls[0]?.[0].requestId).toBeTruthy();
    expect(runner.view.session?.scenarioRevision).toBe((await client.scenario()).revision);
    runner.dispose();
  });

  it('posts both disasters once in the documented request body', async () => {
    const response: DeliberationSession = {
      sessionId: 'atomic-session',
      scenarioRevision: 1,
      disaster: 'Flash flood + Structural fire',
      status: 'triggered',
      createdAt: '2026-09-12T12:00:00Z',
      updatedAt: '2026-09-12T12:00:00Z',
      initialPositions: [],
      crossReview: [],
      source: { provider: 'scripted', model: 'fixture', degraded: true },
      errors: [],
      usage: { calls: 0, latencyMs: 0, hasUnreportedUsage: false }
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ session: response })));
    vi.stubGlobal('fetch', fetch);
    const disasters = [spec('flash_flood'), spec('structural_fire', 'zone-oakland')];
    await createHttpClient('http://test.invalid').startSimulation({
      disasters,
      requestId: 'stable-request'
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      disasters,
      requestId: 'stable-request'
    });
  });
});
