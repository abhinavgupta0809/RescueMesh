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
import { approveRecommendation } from './approvals.js';
import {
  resolveStep,
  scenarioSteps,
  SCRIPT_VERSION,
  STEP_ALLOWED_KINDS
} from './scenario/script.js';
import { SCENARIO_STEPS, type ScenarioStepName } from '@rescuemesh/shared';

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
  /**
   * Advances the recorded scenario script by one operator-selected step.
   * Entirely deterministic: no model is called, and nothing here needs network
   * access or credentials.
   */
  api.post('/api/scenario/advance', (request, response) => {
    const body = request.body as { step?: unknown; commandId?: unknown } | null;
    const step = body?.step;
    if (typeof step !== 'string' || !(SCENARIO_STEPS as readonly string[]).includes(step)) {
      response.status(400).json({ error: 'unknown step', validSteps: SCENARIO_STEPS });
      return;
    }
    const batch = resolveStep(step as ScenarioStepName, world.revision);
    const commandId =
      typeof body?.commandId === 'string' && body.commandId.trim()
        ? body.commandId
        : `${batch.batchId}-cmd`;

    const result = world.execute({
      type: 'scenario.advance',
      commandId,
      issuedAt: new Date().toISOString(),
      payload: {
        batchId: batch.batchId,
        basedOnRevision: batch.basedOnRevision,
        step: batch.step,
        rationale: batch.rationale,
        assumptions: batch.assumptions,
        developments: batch.developments
      }
    });
    if (!result.ok) {
      response.status(HTTP_STATUS_BY_ERROR[result.error.code]).json(result);
      return;
    }
    // World state moved, so cached chief advice no longer describes it.
    if (!result.duplicate) recommendations.invalidate();
    response.json(result);
  });

  /** What the scenario script offers. No provider, no budget: it is recorded content. */
  api.get('/api/scenario/script', (_request, response) => {
    response.json({
      source: 'scripted',
      version: SCRIPT_VERSION,
      steps: scenarioSteps(),
      allowedKindsByStep: STEP_ALLOWED_KINDS
    });
  });

  /**
   * The approval boundary: turns a chief's supported proposed action into an
   * existing engine command. Refuses stale, unknown, resolved, or advisory-only
   * recommendations rather than executing them.
   */
  api.post('/api/recommendations/approve', (request, response) => {
    const body = request.body as {
      recommendationId?: unknown;
      analyzedRevision?: unknown;
      commandId?: unknown;
    } | null;
    if (typeof body?.recommendationId !== 'string' || !body.recommendationId.trim()) {
      response.status(400).json({ error: 'recommendationId is required' });
      return;
    }
    if (!Number.isInteger(body.analyzedRevision) || Number(body.analyzedRevision) < 0) {
      response.status(400).json({ error: 'analyzedRevision must be a non-negative integer' });
      return;
    }
    const outcome = approveRecommendation(world, recommendations, {
      recommendationId: body.recommendationId,
      analyzedRevision: Number(body.analyzedRevision),
      ...(typeof body.commandId === 'string' ? { commandId: body.commandId } : {})
    });
    if (outcome.refusal) {
      const status = outcome.refusal.code === 'not_found' ? 404 : 409;
      response.status(status).json(outcome);
      return;
    }
    if (outcome.command && !outcome.command.ok) {
      response.status(HTTP_STATUS_BY_ERROR[outcome.command.error.code]).json(outcome);
      return;
    }
    recommendations.invalidate();
    response.json(outcome);
  });

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
