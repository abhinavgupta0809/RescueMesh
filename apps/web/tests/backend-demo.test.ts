import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkInvariants } from '@rescuemesh/shared';
import { createApp } from '../../api/src/app';
import { createAdapters } from '../../api/src/adapters';
import type { FetchLike } from '../../api/src/adapters/gemini';
import { createHttpClient, makeCommand } from '../src/api-client';
import { readQueue, writeQueue } from '../src/offline-queue';
import type { Command } from '../src/contract';

// HTTP and engine are real; the only model transport is this injected test function.
// No API key, user's running backend, or paid provider is used by these tests.
const testConfig = {
  apiKey: 'not-a-real-key',
  baseUrl: 'https://example.invalid',
  model: 'gemini-test-stub',
  timeoutMs: 1000,
  maxOutputTokens: 1024,
  temperature: 0
};
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});
async function start(provider: FetchLike | null) {
  const app = createApp({
    adapters: provider ? createAdapters(testConfig, provider) : createAdapters(null)
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return createHttpClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
describe('frontend client → committed backend → deterministic engine', () => {
  it('completes the full demo with mocked Gemini advice, human approval and reset', async () => {
    const provider = vi.fn<FetchLike>(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        summary: 'Review evacuation coverage',
                        action:
                          'Inspect available units before approving the deterministic resource plan.',
                        confidence: 0.8
                      })
                    }
                  ]
                }
              }
            ]
          })
        )
    );
    const client = await start(provider);
    const seed = await client.scenario();
    async function send(command: Command) {
      const result = await client.command(command);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(checkInvariants(await client.scenario())).toEqual([]);
      return result;
    }
    await send(
      makeCommand('scenario.trigger_flood', { intensity: 'severe', zoneIds: ['zone-oakland'] })
    );
    await send(makeCommand('route.close_bridge', { bridgeId: 'bridge-birmingham', closed: true }));
    await send(
      makeCommand('zone.set_connectivity', { zoneId: 'zone-east', connectivity: 'offline' })
    );
    const beforeReport = await client.scenario();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      }
    };
    writeQueue(storage, 'api', [
      {
        clientReportId: 'offline-http-demo',
        zoneId: 'zone-east',
        body: 'Synthetic evacuation assistance at a school',
        capturedAt: seed.simulatedTime,
        syncState: 'queued'
      }
    ]);
    expect((await client.scenario()).incidents).toEqual(beforeReport.incidents);
    await send(
      makeCommand('zone.set_connectivity', { zoneId: 'zone-east', connectivity: 'online' })
    );
    const queued = readQueue(storage, 'api');
    const sync = await send(makeCommand('report.sync', { reports: queued }));
    if (!sync.ok || sync.type !== 'report.sync') throw new Error('Sync failed');
    const acknowledged = [...sync.data.applied, ...sync.data.duplicates].map(
      (r) => r.clientReportId
    );
    writeQueue(
      storage,
      'api',
      queued.filter((r) => !acknowledged.includes(r.clientReportId))
    );
    expect(readQueue(storage, 'api')).toEqual([]);
    expect(provider).not.toHaveBeenCalled();
    const beforeAdvice = await client.scenario();
    const advice = await client.recommendations();
    expect(advice).toHaveLength(5);
    expect(provider).toHaveBeenCalledTimes(5);
    expect(
      advice.every(
        (r) =>
          r.source.provider === 'gemini' &&
          !r.source.degraded &&
          r.analyzedRevision === beforeAdvice.revision &&
          r.recommendation.status === 'pending'
      )
    ).toBe(true);
    expect(await client.scenario()).toEqual(beforeAdvice); // Advice cannot mutate world state.
    await client.recommendations();
    expect(provider).toHaveBeenCalledTimes(5);
    await send(makeCommand('plan.propose', {}));
    const proposed = await client.scenario();
    expect(proposed.resources).toEqual(beforeAdvice.resources);
    const plan = proposed.plans.find((p) => p.status === 'proposed')!;
    // Refresh advisory provenance for the plan's current revision; still no assignment.
    expect(
      (await client.recommendations()).every((r) => r.analyzedRevision === proposed.revision)
    ).toBe(true);
    const approved = await send(
      makeCommand('plan.approve', { planId: plan.id }, proposed.revision)
    );
    expect(approved.ok && approved.type === 'plan.approve' && approved.data.plan.status).toBe(
      'approved'
    );
    const updated = await client.scenario();
    expect(updated.resources.filter((r) => r.status === 'assigned').length).toBeGreaterThan(
      proposed.resources.filter((r) => r.status === 'assigned').length
    );
    expect(updated.events.some((e) => e.type === 'plan_approved')).toBe(true);
    await send(makeCommand('scenario.reset', {}));
    expect(await client.scenario()).toEqual(seed);
  });
  it('preserves fallback provenance when the mocked cloud provider fails', async () => {
    const client = await start(async () => {
      throw new Error('mock cloud unavailable');
    });
    const advice = await client.recommendations();
    expect(
      advice.every((r) => r.source.provider === 'mock' && r.source.degraded && !!r.source.warning)
    ).toBe(true);
  });
  it('shows mock-only provenance and rejects stale approval without changing resources', async () => {
    const client = await start(null);
    expect((await client.recommendations()).every((r) => r.source.provider === 'mock')).toBe(true);
    await client.command(makeCommand('plan.propose', {}));
    const before = await client.scenario();
    const plan = before.plans.find((p) => p.status === 'proposed')!;
    await client.command(
      makeCommand('zone.set_connectivity', { zoneId: 'zone-east', connectivity: 'offline' })
    );
    const failed = await client.command(
      makeCommand('plan.approve', { planId: plan.id }, before.revision)
    );
    expect(!failed.ok && failed.error.code).toBe('revision_conflict');
    expect((await client.scenario()).resources).toEqual(before.resources);
  });
});
