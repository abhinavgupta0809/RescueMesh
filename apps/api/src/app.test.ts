import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './app.js';

describe('RescueMesh API', () => {
  it('reports mock mode health', async () => {
    const response = await request(app).get('/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', mode: 'deterministic-mock' });
  });

  it('serves the fixed demo scenario', async () => {
    const response = await request(app).get('/api/scenario').expect(200);
    expect(response.body.id).toBe('pgh-flash-flood-001');
    expect(response.body.facilities).toHaveLength(10);
  });

  it('validates report parsing input', async () => {
    await request(app).post('/api/reports/parse').send({ report: '' }).expect(400);
  });
});
