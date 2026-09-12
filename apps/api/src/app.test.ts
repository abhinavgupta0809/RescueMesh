import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createAdapters } from './adapters/index.js';
import type { IfmConfig } from './config.js';
import type { FetchLike } from './adapters/ifm.js';

const mockApp = () => createApp(createAdapters(null));

const ifmConfig: IfmConfig = {
  apiKey: 'IFM-test',
  baseUrl: 'https://api.ifm.ai/v1',
  model: 'IFM/K2-Horizon-375B-A23B',
  timeoutMs: 5_000,
  maxTokens: 800,
  temperature: 0.2
};

const liveApp = (fetchImpl?: FetchLike) => createApp(createAdapters(ifmConfig, fetchImpl));

const replyWith =
  (content: string): FetchLike =>
  async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

describe('RescueMesh API (no key pasted)', () => {
  it('reports mock mode health', async () => {
    const response = await request(mockApp()).get('/health').expect(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      mode: 'deterministic-mock',
      reasoning: { provider: 'mock', model: 'deterministic-mock', configured: false }
    });
  });

  it('serves the fixed demo scenario', async () => {
    const response = await request(mockApp()).get('/api/scenario').expect(200);
    expect(response.body.id).toBe('pgh-flash-flood-001');
    expect(response.body.facilities).toHaveLength(10);
  });

  it('validates report parsing input', async () => {
    await request(mockApp()).post('/api/reports/parse').send({ report: '' }).expect(400);
    await request(mockApp())
      .post('/api/reports/parse')
      .send({ report: 'x'.repeat(4001) })
      .expect(400);
  });

  it('labels a parsed report with its reasoning source', async () => {
    const response = await request(mockApp())
      .post('/api/reports/parse')
      .send({ report: 'Two people trapped on a car roof' })
      .expect(200);
    expect(response.body.incident.severity).toBe('critical');
    expect(response.body.source).toEqual({
      provider: 'mock',
      model: 'deterministic-mock',
      degraded: false
    });
  });

  it('returns all five chief recommendations with provenance', async () => {
    const response = await request(mockApp()).get('/api/recommendations').expect(200);
    expect(response.body.items).toHaveLength(5);
    expect(
      response.body.items.map(
        (item: { recommendation: { agent: string } }) => item.recommendation.agent
      )
    ).toEqual([
      'incident_commander',
      'medical_chief',
      'police_chief',
      'rescue_chief',
      'logistics_chief'
    ]);
    expect(response.body.items[0].source.provider).toBe('mock');
  });

  it('rejects an unknown agent role', async () => {
    const response = await request(mockApp()).get('/api/recommendations/mayor').expect(400);
    expect(response.body.validRoles).toHaveLength(5);
  });

  it('serves one role recommendation', async () => {
    const response = await request(mockApp()).get('/api/recommendations/rescue_chief').expect(200);
    expect(response.body.recommendation.agent).toBe('rescue_chief');
  });
});

describe('RescueMesh API (IFM key pasted)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('reports live mode and the model name in health', async () => {
    const response = await request(liveApp()).get('/health').expect(200);
    expect(response.body).toMatchObject({
      mode: 'ifm-live',
      reasoning: { provider: 'ifm', model: 'IFM/K2-Horizon-375B-A23B', configured: true }
    });
  });

  it('parses a report through K2 and attributes it to IFM', async () => {
    const response = await request(
      liveApp(
        replyWith(
          '{"title":"Vehicle trapped in floodwater","description":"Two occupants on the roof.","severity":"critical"}'
        )
      )
    )
      .post('/api/reports/parse')
      .send({ report: 'Squirrel Hill tunnel, two people on a car roof' })
      .expect(200);

    expect(response.body.incident.title).toBe('Vehicle trapped in floodwater');
    expect(response.body.source).toEqual({
      provider: 'ifm',
      model: 'IFM/K2-Horizon-375B-A23B',
      degraded: false
    });
  });

  it('still answers, marked degraded, when IFM rejects the key', async () => {
    const unauthorized: FetchLike = async () => new Response('invalid api key', { status: 401 });
    const response = await request(liveApp(unauthorized))
      .post('/api/reports/parse')
      .send({ report: 'Two people trapped on a car roof' })
      .expect(200);

    expect(response.body.incident.severity).toBe('critical');
    expect(response.body.source.provider).toBe('mock');
    expect(response.body.source.degraded).toBe(true);
    expect(response.body.source.warning).toContain('401');
  });

  it('never lets malformed model output reach a recommendation', async () => {
    const response = await request(liveApp(replyWith('I cannot help with that.')))
      .get('/api/recommendations/medical_chief')
      .expect(200);

    expect(response.body.recommendation.agent).toBe('medical_chief');
    expect(response.body.source).toMatchObject({ provider: 'mock', degraded: true });
  });
});
