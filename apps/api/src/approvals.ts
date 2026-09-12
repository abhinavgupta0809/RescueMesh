import type {
  AgentRecommendation,
  ApprovableAction,
  ApproveRecommendationResponse,
  Command
} from '@rescuemesh/shared';
import type { RecommendationCache } from './recommendations.js';
import type { World } from './world.js';

/**
 * The approval boundary.
 *
 * A chief's recommendation is advice. It becomes a state change only when an
 * operator approves it here, and even then only by being translated into an
 * EXISTING engine command that the engine validates like any other. No model
 * output reaches world state directly, and approval cannot invent a capability
 * the engine does not already have.
 */

/** Translates a supported approved action into the engine command it maps to. */
export const toCommand = (action: ApprovableAction, commandId: string): Command => {
  switch (action.kind) {
    case 'plan.propose':
      return {
        type: 'plan.propose',
        commandId,
        issuedAt: new Date().toISOString(),
        payload: {
          ...(action.incidentIds ? { incidentIds: action.incidentIds } : {}),
          ...(action.reserveUnitsPerKind !== undefined
            ? { reserveUnitsPerKind: action.reserveUnitsPerKind }
            : {})
        }
      };
  }
};

export interface ApprovalInput {
  recommendationId: string;
  /** The revision the operator was looking at when they approved. */
  analyzedRevision: number;
  commandId?: string;
}

/**
 * Refuses rather than executes when the recommendation is unknown, already
 * resolved, advisory-only, or was computed against an older revision. A stale
 * approval must be revalidated — the operator re-reads the chiefs at the current
 * revision before it can execute.
 */
export const approveRecommendation = (
  world: World,
  cache: RecommendationCache,
  input: ApprovalInput
): ApproveRecommendationResponse => {
  const found = cache.find(input.recommendationId);
  if (!found) {
    return {
      ok: false,
      recommendationId: input.recommendationId,
      revision: world.revision,
      refusal: {
        code: 'not_found',
        message: 'No cached recommendation with that id. Refresh the chiefs and try again.'
      }
    };
  }

  const recommendation: AgentRecommendation = found.item.recommendation;
  if (recommendation.status !== 'pending') {
    return {
      ok: false,
      recommendationId: input.recommendationId,
      revision: world.revision,
      refusal: {
        code: 'already_resolved',
        message: `This recommendation is already ${recommendation.status}.`
      }
    };
  }

  // Staleness is checked twice: against what the operator saw, and against the
  // revision the advice itself was computed from.
  const currentRevision = world.revision;
  if (
    input.analyzedRevision !== currentRevision ||
    found.item.analyzedRevision !== currentRevision
  ) {
    return {
      ok: false,
      recommendationId: input.recommendationId,
      revision: currentRevision,
      refusal: {
        code: 'stale_recommendation',
        message:
          `This advice analyzed revision ${found.item.analyzedRevision} and the operator saw ` +
          `revision ${input.analyzedRevision}, but world state is at ${currentRevision}. ` +
          'Refresh the chiefs to revalidate before approving.',
        currentRevision
      }
    };
  }

  const action = recommendation.proposedAction;
  if (!action) {
    return {
      ok: false,
      recommendationId: input.recommendationId,
      revision: currentRevision,
      refusal: {
        code: 'advisory_only',
        message:
          'This recommendation is advisory only: it does not map to a supported engine command. ' +
          'Act on it through the operator controls.'
      }
    };
  }

  const command = toCommand(
    action,
    input.commandId ?? `approve-${input.recommendationId}-${Date.now().toString(36)}`
  );
  const result = world.execute(command);
  if (result.ok) cache.resolve(input.recommendationId, 'accepted');

  return {
    ok: result.ok,
    recommendationId: input.recommendationId,
    revision: world.revision,
    command: result
  };
};
