import { pittsburghFloodScenario } from '@rescuemesh/shared';
import { describe, expect, it, vi } from 'vitest';
import type { IfmConfig } from '../config.js';
import {
  extractJsonObject,
  IfmClient,
  IfmError,
  IfmReasoningAdapter,
  roleContext,
  type FetchLike
} from './ifm.js';

const config: IfmConfig = {
  apiKey: 'IFM-test-key',
  baseUrl: 'https://api.ifm.ai/v1',
  model: 'IFM/K2-Horizon-375B-A23B',
  timeoutMs: 5_000,
  maxTokens: 800,
  temperature: 0.2
};

const replyWith = (content: string, finishReason = 'stop'): FetchLike =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  );

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"severity":"high"}')).toEqual({ severity: 'high' });
  });

  it('reads an object inside a fenced block with prose around it', () => {
    const raw =
      'Here is the draft:\n```json\n{"title":"Water rescue","nested":{"a":1}}\n```\nDone.';
    expect(extractJsonObject(raw)).toEqual({ title: 'Water rescue', nested: { a: 1 } });
  });

  it('ignores braces inside strings', () => {
    expect(extractJsonObject('{"note":"a } brace"}')).toEqual({ note: 'a } brace' });
  });

  it('takes the answer after a reasoning preamble that contains braces', () => {
    const raw = [
      'We need answer JSON only. The shape is {"summary": string, ...} so let me think.',
      'Draft: {"summary":"draft","confidence":0.1} — no, revise.',
      '{"summary":"final answer","confidence":0.9}'
    ].join('\n');
    expect(extractJsonObject(raw)).toEqual({ summary: 'final answer', confidence: 0.9 });
  });

  it('rejects replies with no object or broken JSON', () => {
    expect(() => extractJsonObject('no json here')).toThrow(IfmError);
    expect(() => extractJsonObject('{"a": }')).toThrow(IfmError);
    expect(() => extractJsonObject('{"a": 1')).toThrow(IfmError);
  });
});

describe('IfmClient', () => {
  it('posts to the quickstart endpoint with bearer auth and the configured model', async () => {
    const fetchImpl = replyWith('ready');
    const reply = await new IfmClient(config, fetchImpl).complete([
      { role: 'user', content: 'hello' }
    ]);

    expect(reply).toEqual({ content: 'ready', finishReason: 'stop' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe('https://api.ifm.ai/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer IFM-test-key',
      'Content-Type': 'application/json'
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'IFM/K2-Horizon-375B-A23B',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false
    });
  });

  it('reports HTTP failures with the status and body', async () => {
    const fetchImpl: FetchLike = async () => new Response('invalid api key', { status: 401 });
    await expect(new IfmClient(config, fetchImpl).complete([])).rejects.toMatchObject({
      stage: 'http',
      detail: 'invalid api key'
    });
  });

  it('reports a timeout when the request outlives the budget', async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const client = new IfmClient({ ...config, timeoutMs: 1_000 }, fetchImpl);
    await expect(client.complete([])).rejects.toMatchObject({ stage: 'timeout' });
  });

  it('reports a truncated reasoning reply as a token-cap problem', async () => {
    const adapter = new IfmReasoningAdapter(
      new IfmClient(config, replyWith('We need to answer with JSON. Let me think about', 'length'))
    );
    await expect(adapter.parseReport('two people trapped')).rejects.toMatchObject({
      stage: 'shape',
      message: expect.stringContaining('token cap')
    });
  });

  it('rejects a response with no message content', async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ choices: [] }));
    await expect(new IfmClient(config, fetchImpl).complete([])).rejects.toMatchObject({
      stage: 'shape'
    });
  });
});

describe('IfmReasoningAdapter.parseReport', () => {
  const adapter = (content: string) =>
    new IfmReasoningAdapter(new IfmClient(config, replyWith(content)));

  it('returns a validated incident draft', async () => {
    const result = await adapter(
      '{"title":"Vehicle trapped in floodwater","description":"Two occupants on the roof.","severity":"critical"}'
    ).parseReport('two people trapped');
    expect(result).toEqual({
      title: 'Vehicle trapped in floodwater',
      description: 'Two occupants on the roof.',
      severity: 'critical'
    });
  });

  it('rejects a severity outside the domain enum', async () => {
    await expect(
      adapter('{"title":"x","description":"y","severity":"catastrophic"}').parseReport('report')
    ).rejects.toMatchObject({ stage: 'shape' });
  });

  it('rejects a draft with no title', async () => {
    await expect(
      adapter('{"description":"y","severity":"high"}').parseReport('report')
    ).rejects.toMatchObject({ stage: 'shape' });
  });
});

describe('IfmReasoningAdapter.recommend', () => {
  const firstIncidentId = pittsburghFloodScenario.incidents[0]?.id ?? '';
  const adapter = (content: string) =>
    new IfmReasoningAdapter(new IfmClient(config, replyWith(content)));

  it('keeps an incident id that exists in the scenario', async () => {
    const result = await adapter(
      `{"summary":"Hold one boat in reserve","action":"Stage RB-1 at the rescue center.","confidence":0.82,"relatedIncidentId":"${firstIncidentId}"}`
    ).recommend('rescue_chief', pittsburghFloodScenario);

    expect(result).toMatchObject({
      agent: 'rescue_chief',
      summary: 'Hold one boat in reserve',
      confidence: 0.82,
      status: 'pending',
      relatedIncidentId: firstIncidentId
    });
  });

  it('drops a hallucinated incident id instead of writing it into world state', async () => {
    const result = await adapter(
      '{"summary":"s","action":"a","confidence":0.5,"relatedIncidentId":"inc-does-not-exist"}'
    ).recommend('police_chief', pittsburghFloodScenario);
    expect(result.relatedIncidentId).toBeUndefined();
  });

  it('normalises a percentage confidence and clamps out-of-range values', async () => {
    const asPercent = await adapter('{"summary":"s","action":"a","confidence":78}').recommend(
      'medical_chief',
      pittsburghFloodScenario
    );
    expect(asPercent.confidence).toBe(0.78);

    const negative = await adapter('{"summary":"s","action":"a","confidence":-4}').recommend(
      'medical_chief',
      pittsburghFloodScenario
    );
    expect(negative.confidence).toBe(0);
  });
});

describe('roleContext', () => {
  it('gives the medical chief hospitals and ambulances only', () => {
    const context = roleContext('medical_chief', pittsburghFloodScenario) as {
      hospitals: { id: string }[];
      units: { kind: string }[];
    };
    expect(context.hospitals.length).toBeGreaterThan(0);
    expect(context.units.every((unit) => unit.kind === 'ambulance')).toBe(true);
    expect(context).not.toHaveProperty('policeHubs');
  });

  it('gives the police chief the restricted routes', () => {
    const context = roleContext('police_chief', pittsburghFloodScenario) as {
      restrictedRoutes: { status: string }[];
    };
    expect(context.restrictedRoutes.every((route) => route.status !== 'open')).toBe(true);
  });
});
