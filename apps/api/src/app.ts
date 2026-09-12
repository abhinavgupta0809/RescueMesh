import cors from 'cors';
import express from 'express';
import type {
  AgentRole,
  HealthResponse,
  ParseReportResponse,
  RecommendationResponse,
  RecommendationsResponse
} from '@rescuemesh/shared';
import { adapters as defaultAdapters, type Adapters } from './adapters/index.js';
import { ROLE_TITLES } from './adapters/ifm.js';

const AGENT_ROLES = Object.keys(ROLE_TITLES) as AgentRole[];
const isAgentRole = (value: string): value is AgentRole => AGENT_ROLES.includes(value as AgentRole);

export const createApp = (adapters: Adapters = defaultAdapters) => {
  const api = express();

  api.use(cors());
  api.use(express.json({ limit: '32kb' }));

  api.get('/health', async (_request, response) => {
    const { reasoning } = adapters;
    response.json({
      status: 'ok',
      service: 'rescuemesh-api',
      mode: reasoning.configured ? 'ifm-live' : 'deterministic-mock',
      reasoning: {
        provider: reasoning.configured ? 'ifm' : 'mock',
        model: reasoning.model,
        configured: reasoning.configured
      },
      edge: await adapters.edge.connectivity()
    } satisfies HealthResponse);
  });

  api.get('/api/scenario', async (_request, response) => {
    response.json(await adapters.worldState.loadScenario());
  });

  api.get('/api/world-state', async (_request, response) => {
    const scenario = await adapters.worldState.loadScenario();
    response.json({
      simulatedTime: scenario.simulatedTime,
      status: scenario.status,
      assignments: await adapters.allocation.propose(scenario),
      routes: await adapters.geography.routes(scenario),
      events: scenario.events
    });
  });

  api.post('/api/reports/parse', async (request, response) => {
    const report = typeof request.body?.report === 'string' ? request.body.report : '';
    if (!report.trim()) {
      response.status(400).json({ error: 'report is required' });
      return;
    }
    if (report.length > 4000) {
      response.status(400).json({ error: 'report must be 4000 characters or fewer' });
      return;
    }
    const { value, source } = await adapters.reasoning.parseReportWithSource(report);
    response.json({ incident: value, source } satisfies ParseReportResponse);
  });

  api.get('/api/recommendations', async (_request, response) => {
    const scenario = await adapters.worldState.loadScenario();
    const items = await Promise.all(
      AGENT_ROLES.map(async (role) => {
        const { value, source } = await adapters.reasoning.recommendWithSource(role, scenario);
        return { recommendation: value, source };
      })
    );
    response.json({ items } satisfies RecommendationsResponse);
  });

  api.get('/api/recommendations/:role', async (request, response) => {
    const role = request.params.role;
    if (!isAgentRole(role)) {
      response.status(400).json({ error: 'unknown role', validRoles: AGENT_ROLES });
      return;
    }
    const scenario = await adapters.worldState.loadScenario();
    const { value, source } = await adapters.reasoning.recommendWithSource(role, scenario);
    response.json({ recommendation: value, source } satisfies RecommendationResponse);
  });

  return api;
};

export const app = createApp();
