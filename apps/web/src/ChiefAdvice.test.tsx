import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdviceRequests, ChiefAdvice, emptyAdvice, type AdviceState } from './ChiefAdvice';
import { createMockClient } from './mock-client';
import type { Recommendation } from './contract';

const fixture = async () => (await createMockClient().recommendations())[0]!;
function render(advice: AdviceState, revision = 0, online = true) {
  return renderToStaticMarkup(
    createElement(ChiefAdvice, {
      advice,
      revision,
      online,
      onRefresh: () => {},
      onApprove: () => {},
      approvals: {},
      approving: '',
      disabled: false
    })
  );
}
describe('chief advice presentation', () => {
  it('shows loading independently of simulation and never claims execution', () => {
    const html = render({ ...emptyAdvice, status: 'loading' });
    expect(html).toContain('Loading chief advice');
    expect(html).toContain('No new recommendation has been executed');
    expect(html).toContain('disabled');
  });
  it('labels Gemini only from valid provenance and keeps pending advice separate from execution', async () => {
    const r = await fixture();
    r.source = { provider: 'gemini', model: 'test-model', degraded: false };
    const html = render({ items: [r], status: 'ready', error: '' });
    expect(html).toContain('Gemini-generated');
    expect(html).toContain('Pending operator review');
    expect(html).toContain('not executed');
    expect(render({ items: [r], status: 'ready', error: '' }, 1)).toContain('Stale advice');
  });
  it('distinguishes mock fallback and offline cached advice without implying offline Gemini', async () => {
    const r = await fixture();
    r.source.degraded = true;
    r.source.warning = 'Provider timed out';
    const html = render({ items: [r], status: 'ready', error: '' }, 0, false);
    expect(html).toContain('Scripted fallback');
    expect(html).not.toContain('Gemini-generated');
    expect(html).toContain('Gemini requires a cloud connection');
    expect(html).toContain('Provider timed out');
  });
  it('does not render accepted advice as a dispatch receipt', async () => {
    const r = await fixture();
    r.recommendation.status = 'accepted';
    expect(render({ items: [r], status: 'ready', error: '' })).toContain('Advisory only');
  });
});
describe('async advice lifecycle', () => {
  it('clears old advice during loading and on failure; a later refresh recovers', async () => {
    const requests = new AdviceRequests();
    const history: AdviceState[] = [];
    await requests.load(
      async () => {
        throw new Error('offline');
      },
      (state) => history.push(state)
    );
    expect(history.map((s) => s.status)).toEqual(['loading', 'error']);
    expect(history[1]?.items).toEqual([]);
    expect(render(history[1]!)).toContain('Cloud reasoning is unavailable');
    await requests.load(
      () => createMockClient().recommendations(),
      (state) => history.push(state)
    );
    expect(history.at(-1)?.status).toBe('ready');
  });
  it('ignores late advice from an old revision or reset, including reused revision zero', async () => {
    const requests = new AdviceRequests();
    let finish!: (items: Recommendation[]) => void;
    const seen: AdviceState[] = [];
    const old = requests.load(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      (state) => seen.push(state)
    );
    requests.invalidate();
    await requests.load(
      () => createMockClient().recommendations(),
      (state) => seen.push(state)
    );
    const latest = seen.at(-1);
    finish([]);
    await old;
    expect(seen.at(-1)).toBe(latest);
    expect(latest?.items).toHaveLength(5);
  });
});

describe('advice approval is distinct from dispatch', () => {
  it('offers approval only for advice that maps to an engine action', async () => {
    const items = await createMockClient().recommendations();
    const withAction = items.find((i) => i.recommendation.proposedAction);
    const advisory = items.find((i) => !i.recommendation.proposedAction);
    expect(withAction).toBeDefined();
    expect(advisory).toBeDefined();

    const approvable = render({ items: [withAction!], status: 'ready', error: '' });
    expect(approvable).toContain('Approve — request a plan');
    expect(approvable).toContain('does not dispatch');

    const advisoryOnly = render({ items: [advisory!], status: 'ready', error: '' });
    expect(advisoryOnly).not.toContain('Approve — request a plan');
    expect(advisoryOnly).toContain('Advisory only');
  });

  it('disables approval for stale advice', async () => {
    const items = await createMockClient().recommendations();
    const withAction = items.find((i) => i.recommendation.proposedAction)!;
    const html = render({ items: [withAction], status: 'ready', error: '' }, 99);
    expect(html).toContain('Stale advice');
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('never presents an accepted approval as a dispatch', async () => {
    const items = await createMockClient().recommendations();
    const withAction = items.find((i) => i.recommendation.proposedAction)!;
    const html = renderToStaticMarkup(
      createElement(ChiefAdvice, {
        advice: { items: [withAction], status: 'ready' as const, error: '' },
        revision: 0,
        online: true,
        onRefresh: () => {},
        onApprove: () => {},
        approvals: {
          [withAction.recommendation.id]: {
            ok: true,
            recommendationId: withAction.recommendation.id,
            revision: 1
          }
        },
        approving: '',
        disabled: false
      })
    );
    expect(html).toContain('proposed plan is waiting for your review');
    expect(html).toContain('nothing is dispatched yet');
  });

  it('surfaces a refusal without claiming anything ran', async () => {
    const items = await createMockClient().recommendations();
    const withAction = items.find((i) => i.recommendation.proposedAction)!;
    const html = renderToStaticMarkup(
      createElement(ChiefAdvice, {
        advice: { items: [withAction], status: 'ready' as const, error: '' },
        revision: 0,
        online: true,
        onRefresh: () => {},
        onApprove: () => {},
        approvals: {
          [withAction.recommendation.id]: {
            ok: false,
            recommendationId: withAction.recommendation.id,
            revision: 0,
            refusal: { code: 'stale_recommendation' as const, message: 'Refresh to revalidate.' }
          }
        },
        approving: '',
        disabled: false
      })
    );
    expect(html).toContain('Not executed (stale_recommendation)');
  });
});

describe('local mock approval mirrors the backend boundary', () => {
  it('refuses advisory-only advice and executes a supported action', async () => {
    const client = createMockClient();
    const items = await client.recommendations();
    const advisory = items.find((i) => !i.recommendation.proposedAction)!;
    const refusal = await client.approveAdvice(advisory.recommendation.id, 0);
    expect(refusal.ok).toBe(false);
    expect(refusal.refusal?.code).toBe('advisory_only');

    const withAction = items.find((i) => i.recommendation.proposedAction)!;
    const ok = await client.approveAdvice(withAction.recommendation.id, 0);
    expect(ok.ok).toBe(true);
    expect(ok.command?.ok).toBe(true);
    // a proposed plan, not a dispatch
    const scenario = await client.scenario();
    expect(scenario.plans.some((p) => p.status === 'proposed')).toBe(true);
    expect(scenario.resources.every((r) => r.status !== 'assigned' || r.id !== 'amb-21')).toBe(
      true
    );
  });

  it('refuses a stale approval', async () => {
    const client = createMockClient();
    const items = await client.recommendations();
    const withAction = items.find((i) => i.recommendation.proposedAction)!;
    const stale = await client.approveAdvice(withAction.recommendation.id, 99);
    expect(stale.ok).toBe(false);
    expect(stale.refusal?.code).toBe('stale_recommendation');
  });
});
