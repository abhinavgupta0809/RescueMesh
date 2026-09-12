import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdviceRequests, ChiefAdvice, emptyAdvice, type AdviceState } from './ChiefAdvice';
import { createMockClient } from './mock-client';
import type { Recommendation } from './contract';

const fixture = async () => (await createMockClient().recommendations())[0]!;
function render(advice: AdviceState, revision = 0, online = true) {
  return renderToStaticMarkup(
    createElement(ChiefAdvice, { advice, revision, online, onRefresh: () => {}, disabled: false })
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
