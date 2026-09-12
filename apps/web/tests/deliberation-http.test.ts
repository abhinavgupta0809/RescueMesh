import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTerminalStatus, checkInvariants, type DeliberationSession } from '@rescuemesh/shared';
import { createApp } from '../../api/src/app';
import { World } from '../../api/src/world';
import { createAdapters } from '../../api/src/adapters';
import { GeminiClient, type FetchLike } from '../../api/src/adapters/gemini';
import { DeliberationOrchestrator } from '../../api/src/deliberation/orchestrator';
import { createHttpClient, makeCommand } from '../src/api-client';
import { fixturePosition, fixtureResponse, fixtureBrief } from '../src/deliberation-fixture';
import { DeliberationRunner, canApproveSession, STALE_MESSAGE } from '../src/deliberation-runner';
import type { FrontendClient } from '../src/contract';
import { readQueue, writeQueue } from '../src/offline-queue';

// Explicitly injected clients; never reads a user's Gemini key or calls a paid provider.
const config = {
  apiKey: 'test-only',
  baseUrl: 'https://example.invalid',
  model: 'gemini-injected-test',
  timeoutMs: 40,
  maxOutputTokens: 4096,
  temperature: 0
};
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    server = undefined;
  }
});
async function start(provider: FetchLike | null) {
  const world = new World();
  const app = createApp({
    world,
    adapters: createAdapters(null),
    deliberation: new DeliberationOrchestrator(
      world,
      provider ? new GeminiClient(config, provider) : null
    )
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return createHttpClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
function response(system: string) {
  const value = system.includes('read the other chiefs')
    ? fixtureResponse('rescue_chief')
    : system.includes('opening position')
      ? fixturePosition('rescue_chief')
      : fixtureBrief();
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] })
  );
}
const systemOf = (init: RequestInit) =>
  (JSON.parse(String(init.body)) as { systemInstruction: { parts: { text: string }[] } })
    .systemInstruction.parts[0]!.text;
async function terminal(client: FrontendClient, initial: DeliberationSession) {
  let s = initial;
  const deadline = Date.now() + 2000;
  while (!isTerminalStatus(s.status) && Date.now() < deadline)
    s = await client.simulation(s.sessionId);
  expect(isTerminalStatus(s.status)).toBe(true);
  return s;
}
describe('frontend session client → committed deliberation backend (injected models)', () => {
  it('completes flood → bridge → disconnect → offline queue → sync → Gemini advice → approval → engine update → reset', async () => {
    const provider = vi.fn<FetchLike>(async (_url, init) => response(systemOf(init)));
    const client = await start(provider);
    const seed = await client.scenario();
    async function command(command: Parameters<FrontendClient['command']>[0]) {
      const r = await client.command(command);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(checkInvariants(await client.scenario())).toEqual([]);
      return r;
    }
    await command(
      makeCommand('scenario.trigger_flood', { intensity: 'severe', zoneIds: ['zone-oakland'] })
    );
    await command(
      makeCommand('route.close_bridge', { bridgeId: 'bridge-birmingham', closed: true })
    );
    await command(
      makeCommand('zone.set_connectivity', { zoneId: 'zone-east', connectivity: 'offline' })
    );
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      }
    };
    writeQueue(storage, 'api', [
      {
        clientReportId: 'deliberation-offline',
        zoneId: 'zone-east',
        body: 'Synthetic evacuation request',
        capturedAt: seed.simulatedTime,
        syncState: 'queued'
      }
    ]);
    expect(readQueue(storage, 'api')).toHaveLength(1);
    await command(
      makeCommand('zone.set_connectivity', { zoneId: 'zone-east', connectivity: 'online' })
    );
    const result = await command(
      makeCommand('report.sync', { reports: readQueue(storage, 'api') })
    );
    if (!result.ok || result.type !== 'report.sync') throw new Error('Sync failed');
    const ids = [...result.data.applied, ...result.data.duplicates].map((r) => r.clientReportId);
    writeQueue(
      storage,
      'api',
      readQueue(storage, 'api').filter((r) => !ids.includes(r.clientReportId))
    );
    expect(readQueue(storage, 'api')).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
    const before = await client.scenario();
    const runner = new DeliberationRunner(() => {}, 5);
    await runner.start(client, { step: 'initial_flooding' }, async () =>
      runner.observe(await client.scenario())
    );
    await vi.waitFor(() => expect(runner.view.phase).toBe('done'), { timeout: 2000, interval: 10 });
    expect(runner.view.session?.source).toMatchObject({
      provider: 'gemini',
      model: 'gemini-injected-test',
      degraded: false
    });
    expect(provider).toHaveBeenCalledTimes(11);
    const s = runner.view.session!;
    const proposed = await client.scenario();
    const plan = proposed.plans.find((p) => p.id === s.planId)!;
    expect(proposed.resources).toEqual(before.resources);
    expect(canApproveSession(runner.view, plan, proposed.revision)).toBe(true);
    await client.simulation(s.sessionId);
    await client.simulation(s.sessionId);
    await client.finalPlan(s.sessionId);
    expect(provider).toHaveBeenCalledTimes(11); // Polling and candidate retries never add Gemini calls.
    await command(makeCommand('plan.approve', { planId: plan.id }, proposed.revision));
    const approved = await client.scenario();
    expect(approved.events.some((e) => e.type === 'plan_approved')).toBe(true);
    expect(approved.resources).not.toEqual(proposed.resources);
    runner.reset();
    await command(makeCommand('scenario.reset', {}));
    expect(await client.scenario()).toEqual(seed);
    await expect(client.simulation(s.sessionId)).rejects.toThrow('404');
    runner.dispose();
  });
  it.each([
    'one chief unavailable',
    'complete Gemini failure',
    'malformed response',
    'timeout',
    'no configured provider'
  ] as const)('renders the committed fallback shape for %s', async (failure) => {
    const provider = vi.fn<FetchLike>(async (_url, init) => {
      const system = systemOf(init);
      if (
        failure === 'complete Gemini failure' ||
        (failure === 'one chief unavailable' && system.includes('Medical Chief'))
      )
        throw new Error('Injected cloud failure');
      if (failure === 'malformed response')
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '{invalid' }] } }] })
        );
      if (failure === 'timeout')
        return await new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })),
            { once: true }
          )
        );
      return response(system);
    });
    const client = await start(failure === 'no configured provider' ? null : provider);
    const s = await terminal(client, await client.startSimulation({}));
    expect(s.status).toBe('degraded');
    expect(s.source.degraded).toBe(true);
    expect(s.initialPositions).toHaveLength(5);
    expect(s.crossReview).toHaveLength(5);
    expect(s.finalBrief).toBeDefined();
    expect(s.initialPositions.some((p) => p.substituted)).toBe(true);
    if (failure === 'malformed response')
      expect(s.errors.some((e) => e.code === 'malformed_output')).toBe(true);
    if (failure === 'timeout') expect(s.errors.some((e) => e.code === 'timeout')).toBe(true);
    const planned = await client.finalPlan(s.sessionId);
    expect(planned.planId).toBeTruthy();
    // Cloud failures do not affect deterministic commands.
    expect(
      (
        await client.command(
          makeCommand('route.close_bridge', { bridgeId: 'bridge-birmingham', closed: true })
        )
      ).ok
    ).toBe(true);
  });
  it('rejects stale final-plan requests and stops the frontend runner', async () => {
    const client = await start(null);
    const s = await terminal(client, await client.startSimulation({}));
    await client.command(
      makeCommand('zone.set_connectivity', { zoneId: 'zone-east', connectivity: 'offline' })
    );
    await expect(client.finalPlan(s.sessionId)).rejects.toMatchObject({ code: 'stale_session' });
    const runner = new DeliberationRunner(() => {});
    vi.spyOn(client, 'startSimulation').mockResolvedValue(s);
    await runner.start(client, {}, async () => {});
    expect(runner.view.stale).toBe(true);
    expect(runner.view.error).toBe(STALE_MESSAGE);
    expect((await client.scenario()).plans).toEqual([]);
  });
});
