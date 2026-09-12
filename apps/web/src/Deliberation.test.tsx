import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pittsburghFloodScenario, type DeliberationSession } from '@rescuemesh/shared';
import { createHttpClient, makeCommand } from './api-client';
import { createMockClient } from './mock-client';
import { Deliberation } from './Deliberation';
import { CHIEF_ROLES, readSession } from './deliberation-contract';
import { fixtureBrief, fixturePosition, fixtureResponse } from './deliberation-fixture';
import { defaultExercise } from './ExerciseBuilder';
import {
  DeliberationRunner,
  emptyDeliberation,
  canApproveSession,
  STALE_MESSAGE,
  type DeliberationView
} from './deliberation-runner';

function session(overrides: Partial<DeliberationSession> = {}): DeliberationSession {
  return {
    sessionId: 'test-session',
    scenarioRevision: 0,
    disaster: 'Scripted step: initial_flooding',
    status: 'ready',
    createdAt: '2026-09-12T12:00:00Z',
    updatedAt: '2026-09-12T12:00:00Z',
    initialPositions: CHIEF_ROLES.map(fixturePosition),
    crossReview: CHIEF_ROLES.map(fixtureResponse),
    finalBrief: fixtureBrief(),
    source: { provider: 'gemini', model: 'gemini-test-only', degraded: false },
    errors: [],
    usage: { calls: 11, latencyMs: 10, hasUnreportedUsage: true },
    ...overrides
  };
}
const view = (s: DeliberationSession): DeliberationView => ({
  ...emptyDeliberation,
  phase: 'polling',
  session: s
});
const render = (v: DeliberationView, online = true) =>
  renderToStaticMarkup(
    createElement(Deliberation, {
      view: v,
      scenario: pittsburghFloodScenario,
      disasters: defaultExercise(),
      acknowledgedDisasters: v.session ? defaultExercise() : [],
      disabled: false,
      online,
      onDisastersChange: () => {},
      onSimulate: () => {},
      onResume: () => {}
    })
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('public deliberation presentation', () => {
  it('waits for acknowledgement and disables duplicate triggers during loading', () => {
    const html = render({ ...emptyDeliberation, phase: 'starting' });
    expect(html).toContain('Waiting for backend acknowledgement');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain('Deterministic disaster triggered');
  });
  it.each(['triggered', 'initial_analysis', 'cross_review', 'synthesis', 'validating'] as const)(
    'shows the %s progress stage and exactly five role cards',
    (status) => {
      const html = render(view(session({ status, initialPositions: [], crossReview: [] })));
      expect(html.match(/class="chief-position"/g)).toHaveLength(5);
      expect(html.match(/aria-current="step"/g)).toHaveLength(1);
      for (const label of [
        'Deterministic scenario',
        'Gemini deliberation',
        'Cross-review',
        'Incident Commander synthesis',
        'Engine-validated plan',
        'Human approval required'
      ])
        expect(html).toContain(label);
      expect(html).toContain('Approval is disabled');
    }
  );
  it('renders partial positions, debate, synthesis and separates advice from the plan', () => {
    const partial = render(view(session({ initialPositions: [fixturePosition('rescue_chief')] })));
    expect(partial.match(/Awaiting initial position/g)).toHaveLength(4);
    const html = render({ ...view(session({ planId: 'engine-plan-1' })), phase: 'done' });
    for (const label of [
      'Initial position',
      'Agreement',
      'Objection',
      'Revised recommendation',
      'Commander synthesis',
      'Engine-validated plan',
      'Scenario revision 0',
      'Confidence',
      'gemini-test-only'
    ])
      expect(html).toContain(label);
    expect(html).toContain('Chief prose is not executed');
    expect(html).not.toMatch(/chain.of.thought/i);
    expect(html).toContain('Nothing is dispatched by deliberation');
  });
  it('labels a substituted chief and substituted synthesis as fallback, not Gemini', () => {
    const s = session({
      status: 'degraded',
      source: {
        provider: 'gemini',
        model: 'gemini-test-only',
        degraded: true,
        warning: 'One chief failed'
      },
      initialPositions: CHIEF_ROLES.map((role) => ({
        ...fixturePosition(role),
        substituted: role === 'medical_chief'
      })),
      errors: [{ code: 'timeout', stage: 'synthesis', message: 'Timed out', at: 'test' }]
    });
    const html = render(view(s));
    // Exactly the substituted contributions are marked: the Medical Chief
    // opening position and the fallback synthesis. Nothing else.
    expect(html.match(/>Scripted fallback<\/strong>/g)).toHaveLength(2);
    expect(html).toContain('recorded-deliberation-v1');
    // The session-wide degraded banner must NOT appear on successful cards.
    expect(html).not.toContain('Degraded warning');
    expect(html).toContain('This contribution used the recorded fallback');
    // One concise session summary names what fell back and what did not.
    expect(html).toContain('9 of 11 contributions came from Gemini');
    expect(html).toContain('Medical Chief opening position');
    // The four live chiefs read as Gemini, not as scripted or broken.
    expect(html.match(/>Gemini<\/strong>/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // Raw provider detail is collapsed, not in the primary interface.
    expect(html).toContain('Technical details');
  });
  it('labels every recorded section as fallback and displays offline and stale warnings', () => {
    const html = render(
      {
        ...view(
          session({
            source: { provider: 'scripted', model: 'recorded-deliberation-v1', degraded: true }
          })
        ),
        stale: true,
        error: STALE_MESSAGE
      },
      false
    );
    expect(html.match(/>Scripted fallback<\/strong>/g)).toHaveLength(11);
    expect(html.match(/Scenario revision 0 · Stale/g)).toHaveLength(11);
    expect(html).toContain(STALE_MESSAGE);
    expect(html).toContain('Gemini does not work offline');
  });
  it('explains slow synthesis and backend failure without locking deterministic controls', () => {
    expect(render({ ...view(session({ status: 'synthesis' })), slow: true })).toContain(
      'Commander synthesis is taking longer'
    );
    const html = render({
      ...emptyDeliberation,
      phase: 'error',
      error: 'Backend unavailable. No dispatch confirmed.'
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Resume existing session');
    expect(html).not.toContain('Final plan ready');
  });
});

describe('deliberation single-flight and polling lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  it('runs recorded progress to a real engine candidate, requires approval, then stops polling', async () => {
    const client = createMockClient();
    const poll = vi.spyOn(client, 'simulation');
    const advice = vi.spyOn(client, 'recommendations');
    const runner = new DeliberationRunner(() => {});
    const refresh = async () => runner.observe(await client.scenario());
    const seed = await client.scenario();
    await runner.start(client, { step: 'initial_flooding' }, refresh);
    expect((await client.scenario()).revision).toBeGreaterThan(seed.revision);
    expect(canApproveSession(runner.view, undefined, 1)).toBe(false);
    await vi.advanceTimersByTimeAsync(6000);
    const world = await client.scenario();
    const plan = world.plans.find((p) => p.id === runner.view.session?.planId)!;
    expect(runner.view.phase).toBe('done');
    expect(runner.view.stale).toBe(false);
    expect(canApproveSession(runner.view, plan, world.revision)).toBe(true);
    expect(world.resources).toEqual(seed.resources);
    expect(advice).not.toHaveBeenCalled();
    const calls = poll.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(poll).toHaveBeenCalledTimes(calls);
    const approved = await client.command(
      makeCommand('plan.approve', { planId: plan.id }, world.revision)
    );
    expect(approved.ok).toBe(true);
    runner.observe(await client.scenario());
    expect(runner.view.stale).toBe(false);
    expect(canApproveSession(runner.view, plan, (await client.scenario()).revision)).toBe(false);
  });
  it('locks synchronously against duplicate clicks before the POST returns', async () => {
    const client = createMockClient();
    const pending = deferred<DeliberationSession>();
    const start = vi.spyOn(client, 'startSimulation').mockReturnValue(pending.promise);
    const runner = new DeliberationRunner(() => {});
    const first = runner.start(client, {}, async () => {});
    await runner.start(client, {}, async () => {});
    expect(start).toHaveBeenCalledTimes(1);
    runner.reset();
    pending.resolve(session());
    await first;
    expect(runner.view).toEqual(emptyDeliberation);
  });
  it('aborts a pending status read and ignores its completion after unmount', async () => {
    const client = createMockClient();
    const pending = deferred<DeliberationSession>();
    const poll = vi.spyOn(client, 'simulation').mockReturnValue(pending.promise);
    const publish = vi.fn();
    const runner = new DeliberationRunner(publish);
    await runner.start(client, {}, async () => {});
    await vi.advanceTimersByTimeAsync(1000);
    runner.dispose();
    expect(poll.mock.calls[0]?.[1]?.aborted).toBe(true);
    const count = publish.mock.calls.length;
    pending.resolve(session());
    await vi.advanceTimersByTimeAsync(10000);
    expect(publish).toHaveBeenCalledTimes(count);
    expect(poll).toHaveBeenCalledTimes(1);
  });
  it('stops on an external state change and prevents stale approval', async () => {
    const client = createMockClient();
    const poll = vi.spyOn(client, 'simulation');
    const runner = new DeliberationRunner(() => {});
    await runner.start(client, {}, async () => runner.observe(await client.scenario()));
    await client.command(
      makeCommand('route.close_bridge', { bridgeId: 'bridge-birmingham', closed: true })
    );
    runner.observe(await client.scenario());
    expect(runner.view.error).toBe(STALE_MESSAGE);
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).not.toHaveBeenCalled();
    expect(canApproveSession(runner.view, undefined, 1)).toBe(false);
  });
  it.each(['stale', 'failed'] as const)(
    'stops polling at terminal %s without creating a plan',
    async (status) => {
      const client = createMockClient();
      vi.spyOn(client, 'startSimulation').mockResolvedValue(session({ status }));
      const poll = vi.spyOn(client, 'simulation');
      const plan = vi.spyOn(client, 'finalPlan');
      const runner = new DeliberationRunner(() => {});
      await runner.start(client, {}, async () => {});
      await vi.advanceTimersByTimeAsync(10000);
      expect(poll).not.toHaveBeenCalled();
      expect(plan).not.toHaveBeenCalled();
      expect(runner.view.error).not.toBe('');
    }
  );
  it('keeps approval disabled during slow synthesis, times out, and resumes with GET only', async () => {
    const client = createMockClient();
    const s = session({ status: 'synthesis' });
    vi.spyOn(client, 'startSimulation').mockResolvedValue(s);
    vi.spyOn(client, 'simulation').mockResolvedValue(s);
    const runner = new DeliberationRunner(() => {}, 1000, 20000);
    await runner.start(client, {}, async () => {});
    await vi.advanceTimersByTimeAsync(16000);
    expect(runner.view.slow).toBe(true);
    expect(canApproveSession(runner.view, undefined, 0)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(runner.view.phase).toBe('error');
    expect(runner.view.error).toContain('timed out');
    await runner.resume();
    expect(client.startSimulation).toHaveBeenCalledTimes(1);
    runner.dispose();
  });
  it('retries an uncertain trigger with the identical requestId and no assumed success', async () => {
    const client = createMockClient();
    const start = vi
      .spyOn(client, 'startSimulation')
      .mockRejectedValueOnce(new Error('Backend unavailable'));
    const runner = new DeliberationRunner(() => {});
    await runner.start(client, { step: 'initial_flooding' }, async () => {});
    expect(runner.view.phase).toBe('error');
    expect(runner.view.session).toBeUndefined();
    await runner.start(client, { step: 'initial_flooding' }, async () => {});
    expect(start).toHaveBeenCalledTimes(1);
    await runner.resume();
    expect(start.mock.calls[0]?.[0]).toEqual(start.mock.calls[1]?.[0]);
    runner.dispose();
  });
  it('does not unlock approval when final-plan acknowledgement is still pending or failed', async () => {
    const client = createMockClient();
    vi.spyOn(client, 'startSimulation').mockResolvedValue(session());
    const pending = deferred<DeliberationSession>();
    vi.spyOn(client, 'finalPlan').mockReturnValue(pending.promise);
    const runner = new DeliberationRunner(() => {});
    const start = runner.start(client, {}, async () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.view.phase).toBe('planning');
    expect(canApproveSession(runner.view, undefined, 0)).toBe(false);
    runner.reset();
    pending.resolve(session({ planId: 'late-plan' }));
    await start;
    expect(runner.view).toEqual(emptyDeliberation);
  });
  it('reset clears the recorded session and allows a fresh run at reused revisions', async () => {
    const client = createMockClient();
    const runner = new DeliberationRunner(() => {});
    await runner.start(client, {}, async () => {});
    const id = runner.view.session!.sessionId;
    runner.reset();
    await client.command(makeCommand('scenario.reset', {}));
    await expect(client.simulation(id)).rejects.toThrow('Unknown session');
    await vi.advanceTimersByTimeAsync(10000);
    expect(runner.view).toEqual(emptyDeliberation);
    await runner.start(client, {}, async () => {});
    expect(runner.view.session!.sessionId).not.toBe(id);
    runner.dispose();
  });
});

describe('typed deliberation HTTP boundary', () => {
  it('uses only committed session routes and rejects a missing final-plan receipt', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ session: session() })));
    vi.stubGlobal('fetch', fetch);
    const client = createHttpClient('http://test.invalid');
    await client.startSimulation({ step: 'initial_flooding', requestId: 'same-key' });
    await client.simulation('id/with slash');
    await expect(client.finalPlan('id')).rejects.toThrow('did not confirm');
    expect(fetch.mock.calls.map((c) => [c[0], c[1].method ?? 'GET'])).toEqual([
      ['http://test.invalid/api/simulations', 'POST'],
      ['http://test.invalid/api/simulations/id%2Fwith%20slash', 'GET'],
      ['http://test.invalid/api/simulations/id/final-plan', 'POST']
    ]);
  });
  it('rejects malformed wire output instead of inventing a successful fallback', () => {
    expect(() =>
      readSession({
        session: session({ source: { provider: 'scripted', model: '', degraded: true } })
      })
    ).toThrow('contract');
    expect(() => readSession({ session: session({ initialPositions: [] }) })).toThrow('contract');
    expect(() =>
      readSession({
        session: session({
          initialPositions: CHIEF_ROLES.map(() => fixturePosition('medical_chief'))
        })
      })
    ).toThrow('contract');
    expect(readSession({ session: session() }).source.provider).toBe('gemini');
  });
  it('surfaces backend unavailability and stale final-plan refusal without mock switching', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const client = createHttpClient('http://test.invalid');
    await expect(client.startSimulation({})).rejects.toThrow('No success has been assumed');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'stale_session', message: 'Revision changed' }), {
          status: 409
        })
      )
    );
    await expect(client.finalPlan('id')).rejects.toMatchObject({ code: 'stale_session' });
    expect(client.mode).toBe('api');
  });
});
