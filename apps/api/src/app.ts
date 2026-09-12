import cors from 'cors';
import express from 'express';
import type {
  HealthResponse,
  ParseReportResponse,
  RecommendationResponse,
  RecommendationsResponse
} from '@rescuemesh/shared';
import { adapters as defaultAdapters, type Adapters } from './adapters/index.js';
import { AGENT_ROLES, RecommendationCache } from './recommendations.js';
import { HTTP_STATUS_BY_ERROR, parseCommand, World } from './world.js';

const isAgentRole = (value: string): value is (typeof AGENT_ROLES)[number] =>
  (AGENT_ROLES as string[]).includes(value);

export interface AppOptions {
  adapters?: Adapters;
  world?: World;
}

export const createApp = ({ adapters = defaultAdapters, world = new World() }: AppOptions = {}) => {
  const api = express();
  const recommendations = new RecommendationCache(adapters.reasoning);

  api.use(cors());
  api.use(express.json({ limit: '64kb' }));

  api.get('/health', async (_request, response) => {
    const { reasoning } = adapters;
    response.json({
      status: 'ok',
      service: 'rescuemesh-api',
      mode: reasoning.configured ? 'gemini-live' : 'deterministic-mock',
      reasoning: {
        provider: reasoning.provider,
        model: reasoning.model,
        configured: reasoning.configured
      },
      edge: await adapters.edge.connectivity()
    } satisfies HealthResponse);
  });

  /** The authoritative scenario, straight from the simulation engine. */
  api.get('/api/scenario', (_request, response) => {
    response.json(world.scenario);
  });

  /**
   * Polling endpoint. `?since=<revision>` returns only what changed; omitting it
   * returns the whole world.
   */
  api.get('/api/world-state', (request, response) => {
    const raw = request.query.since;
    if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw))) {
      response.status(400).json({ error: 'since must be a non-negative integer' });
      return;
    }
    response.json(world.worldStateSince(raw === undefined ? undefined : Number(raw)));
  });

  /**
   * Every state change enters here. The simulation engine validates and applies
   * it; this handler only translates the result to HTTP.
   */
  api.post('/api/commands', (request, response) => {
    const parsed = parseCommand(request.body);
    if (!parsed.ok) {
      const body = request.body as { commandId?: unknown; type?: unknown } | null;
      response.status(400).json({
        ok: false,
        commandId: typeof body?.commandId === 'string' ? body.commandId : 'unknown',
        type: 'unknown',
        revision: world.revision,
        error: { code: 'validation_failed', message: parsed.reason, retryable: false }
      });
      return;
    }

    const result = world.execute(parsed.command);
    if (!result.ok) {
      response.status(HTTP_STATUS_BY_ERROR[result.error.code]).json(result);
      return;
    }
    // Advice is tied to the revision it analyzed, so a state change retires it.
    if (!result.duplicate) recommendations.invalidate();
    response.json(result);
  });

  /**
   * The five Gemini chiefs analyze the current scenario. Memoised per revision:
   * polling at an unchanged revision calls no model.
   */
  api.get('/api/recommendations', async (_request, response) => {
    response.json((await recommendations.get(world.scenario)) satisfies RecommendationsResponse);
  });

  api.get('/api/recommendations/:role', async (request, response) => {
    const role = request.params.role;
    if (!isAgentRole(role)) {
      response.status(400).json({ error: 'unknown role', validRoles: AGENT_ROLES });
      return;
    }
    const scenario = world.scenario;
    const { value, source } = await adapters.reasoning.recommendWithSource(role, scenario);
    response.json({
      recommendation: value,
      source,
      analyzedRevision: scenario.revision
    } satisfies RecommendationResponse);
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

  return api;
};

export const app = createApp();
