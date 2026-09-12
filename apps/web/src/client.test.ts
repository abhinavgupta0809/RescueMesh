import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockClient, createSeed } from './mock-client';
import { createHttpClient, makeCommand, validateScenario } from './api-client';
import { readQueue, writeQueue } from './offline-queue';
import type { Command, Scenario } from './contract';

const report = {
  clientReportId: 'device-report-1',
  zoneId: 'zone-c',
  body: 'Synthetic school evacuation report',
  capturedAt: '2026-07-18T22:43:00Z'
};
function invariants(s: Scenario) {
  expect(s.facilities.filter((f) => f.kind === 'hospital')).toHaveLength(3);
  expect(s.facilities.filter((f) => f.kind === 'fire_house').length).toBeGreaterThanOrEqual(3);
  expect(s.facilities.filter((f) => f.kind === 'police_hub')).toHaveLength(2);
  expect(s.facilities.filter((f) => f.kind === 'rescue_center')).toHaveLength(2);
  const held = s.assignments
    .filter((a) => ['approved', 'dispatched'].includes(a.status))
    .flatMap((a) => a.resourceIds);
  expect(new Set(held).size).toBe(held.length);
  expect(
    s.resources.filter((r) => held.includes(r.id)).every((r) => r.status !== 'available')
  ).toBe(true);
  expect(s.zones.flatMap((z) => z.facilityIds).sort()).toEqual(
    s.facilities.map((f) => f.id).sort()
  );
  expect(s.plans.filter((p) => p.status === 'proposed').length).toBeLessThanOrEqual(1);
  for (const b of s.bridges.filter((b) => b.status === 'closed'))
    expect(
      s.routes.filter((r) => b.routeIds.includes(r.id)).every((r) => r.status === 'closed')
    ).toBe(true);
}
afterEach(() => vi.unstubAllGlobals());
describe('deterministic eight-step demo', () => {
  it('replaying a reset cannot erase subsequent commands', async () => {
    const client = createMockClient();
    const reset = makeCommand('scenario.reset', {});
    await client.command(reset);
    await client.command(makeCommand('scenario.trigger_flood', { intensity: 'severe' }));
    const before = await client.scenario();
    const duplicate = await client.command(reset);
    expect(duplicate.ok && duplicate.duplicate).toBe(true);
    expect(await client.scenario()).toEqual(before);
  });
  it('flood → closure → offline report → exactly-once sync → reviewed plan → approval → reset', async () => {
    const client = createMockClient();
    async function send(command: Command) {
      const response = await client.command(command);
      expect(response.ok).toBe(true);
      invariants(await client.scenario());
      return response;
    }
    await send(makeCommand('scenario.trigger_flood', { intensity: 'severe', zoneIds: ['zone-b'] }));
    const close = makeCommand('route.close_bridge', {
      bridgeId: 'bridge-birmingham',
      closed: true
    });
    await send(close);
    const beforeReplay = await client.scenario();
    const replay = await send(close);
    expect(replay.ok && replay.duplicate).toBe(true);
    expect(await client.scenario()).toEqual(beforeReplay);
    await send(makeCommand('zone.set_connectivity', { zoneId: 'zone-c', connectivity: 'offline' }));
    const offline = await client.command(makeCommand('report.submit', report));
    expect(!offline.ok && offline.error.code).toBe('zone_offline');
    expect((await client.scenario()).reports).toHaveLength(0);
    await send(makeCommand('zone.set_connectivity', { zoneId: 'zone-c', connectivity: 'online' }));
    await send(makeCommand('report.sync', { reports: [report] }));
    const synced = await client.scenario();
    const repeated = await send(makeCommand('report.sync', { reports: [report] }));
    expect(repeated.ok && repeated.type === 'report.sync' && repeated.data.duplicates).toHaveLength(
      1
    );
    expect(await client.scenario()).toEqual(synced);
    const proposed = await send(makeCommand('plan.propose', {}));
    expect(proposed.ok && proposed.type === 'plan.propose').toBe(true);
    const afterProposal = await client.scenario();
    expect(afterProposal.resources).toEqual(synced.resources);
    const plan = afterProposal.plans[0]!;
    expect(plan.shortfalls.length).toBeGreaterThan(0);
    await send(makeCommand('plan.approve', { planId: plan.id }, afterProposal.revision));
    const approved = await client.scenario();
    expect(approved.resources.find((r) => r.id === 'pol-42')?.status).toBe('assigned');
    expect(approved.events.some((e) => e.type === 'plan_approved')).toBe(true);
    const repeatApprove = await client.command(makeCommand('plan.approve', { planId: plan.id }));
    expect(!repeatApprove.ok && repeatApprove.error.code).toBe('plan_not_proposed');
    await send(makeCommand('scenario.reset', {}));
    expect(await client.scenario()).toEqual(createSeed());
  });
  it('rejects stale approvals and leaves all resources untouched', async () => {
    const client = createMockClient();
    await client.command(makeCommand('plan.propose', {}));
    const planned = await client.scenario();
    await client.command(
      makeCommand('zone.set_connectivity', { zoneId: 'zone-c', connectivity: 'offline' })
    );
    const result = await client.command(
      makeCommand('plan.approve', { planId: planned.plans[0]!.id })
    );
    expect(!result.ok && result.error.code).toBe('plan_stale');
    expect((await client.scenario()).resources).toEqual(planned.resources);
  });
  it('supersedes proposals, honors reserves and rejects invalid sync without losing reports', async () => {
    const client = createMockClient();
    await client.command(makeCommand('plan.propose', {}));
    await client.command(makeCommand('plan.propose', {}));
    const state = await client.scenario();
    expect(state.plans.map((p) => p.status)).toEqual(['superseded', 'proposed']);
    const reserve = await client.command(makeCommand('plan.propose', { reserveUnitsPerKind: 1 }));
    expect(!reserve.ok && reserve.error.code).toBe('infeasible');
    const invalid = await client.command(
      makeCommand('report.sync', { reports: [{ ...report, body: '' }] })
    );
    expect(invalid.ok && invalid.type === 'report.sync' && invalid.data.rejected).toHaveLength(1);
    expect((await client.scenario()).reports).toHaveLength(0);
  });
});
describe('HTTP boundary and offline persistence', () => {
  it('never turns a network failure into a mock success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const client = createHttpClient('http://example.test');
    expect(client.mode).toBe('api');
    await expect(client.command(makeCommand('scenario.reset', {}))).rejects.toThrow(
      'No success has been assumed'
    );
  });
  it('preserves structured failures and fetches full state when polling supplies only events', async () => {
    const command = makeCommand('plan.approve', { planId: 'missing' });
    const failure = {
      ok: false,
      commandId: command.commandId,
      type: command.type,
      revision: 0,
      error: { code: 'not_found', message: 'Plan missing', retryable: false }
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(failure), { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revision: 1, upToDate: false, events: [] }))
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(createSeed())));
    vi.stubGlobal('fetch', fetchMock);
    const client = createHttpClient('http://example.test');
    expect(await client.command(command)).toEqual(failure);
    expect(await client.poll(0)).toEqual(createSeed());
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://example.test/api/world-state?since=0');
  });
  it('rejects the old read-only schema and malformed acknowledgements', async () => {
    expect(() => validateScenario({ facilities: [] })).toThrow('interactive contract');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }))));
    await expect(createHttpClient('').command(makeCommand('scenario.reset', {}))).rejects.toThrow(
      'Invalid command acknowledgement'
    );
  });
  it('round-trips report IDs across reloads and isolates API and mock queues', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      }
    };
    writeQueue(storage, 'mock', [{ ...report, syncState: 'queued' }]);
    expect(readQueue(storage, 'mock')[0]?.clientReportId).toBe(report.clientReportId);
    expect(readQueue(storage, 'api')).toEqual([]);
    expect(() => readQueue({ getItem: () => '{broken' }, 'mock')).toThrow();
    expect(() =>
      writeQueue(
        {
          setItem: () => {
            throw new Error('quota');
          }
        },
        'mock',
        []
      )
    ).toThrow('quota');
  });
});
