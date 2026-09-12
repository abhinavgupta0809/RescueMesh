import cors from 'cors';
import express from 'express';
import { adapters } from './adapters/mock.js';

export const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', async (_request, response) => {
  response.json({
    status: 'ok',
    service: 'rescuemesh-api',
    mode: 'deterministic-mock',
    edge: await adapters.edge.connectivity()
  });
});

app.get('/api/scenario', async (_request, response) => {
  response.json(await adapters.worldState.loadScenario());
});

app.get('/api/world-state', async (_request, response) => {
  const scenario = await adapters.worldState.loadScenario();
  response.json({
    simulatedTime: scenario.simulatedTime,
    status: scenario.status,
    assignments: await adapters.allocation.propose(scenario),
    routes: await adapters.geography.routes(scenario),
    events: scenario.events
  });
});

app.post('/api/reports/parse', async (request, response) => {
  const report = typeof request.body?.report === 'string' ? request.body.report : '';
  if (!report.trim()) {
    response.status(400).json({ error: 'report is required' });
    return;
  }
  response.json(await adapters.reasoning.parseReport(report));
});
