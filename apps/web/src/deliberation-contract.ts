import {
  DELIBERATION_STAGES,
  DELIBERATION_TERMINAL_STATUSES,
  validateChiefPosition,
  validateChiefResponse,
  validateFinalBrief,
  type DeliberationSession,
  type AgentRole
} from '@rescuemesh/shared';

export const CHIEF_ROLES: readonly AgentRole[] = [
  'incident_commander',
  'medical_chief',
  'police_chief',
  'rescue_chief',
  'logistics_chief'
];

/** Validate the committed wire envelope before showing any model-authored content. */
export function readSession(value: unknown): DeliberationSession {
  const s = (value as { session?: DeliberationSession } | null)?.session;
  const invalid = () =>
    new Error('Deliberation response does not match the committed contract. No plan was accepted.');
  if (
    !s ||
    typeof s.sessionId !== 'string' ||
    !s.sessionId ||
    !Number.isInteger(s.scenarioRevision) ||
    s.scenarioRevision < 0 ||
    ![...DELIBERATION_STAGES, ...DELIBERATION_TERMINAL_STATUSES].includes(s.status) ||
    typeof s.disaster !== 'string' ||
    typeof s.createdAt !== 'string' ||
    typeof s.updatedAt !== 'string' ||
    !s.source ||
    !['gemini', 'scripted'].includes(s.source.provider) ||
    typeof s.source.model !== 'string' ||
    !s.source.model.trim() ||
    typeof s.source.degraded !== 'boolean' ||
    (s.source.warning !== undefined && typeof s.source.warning !== 'string') ||
    !Array.isArray(s.initialPositions) ||
    !Array.isArray(s.crossReview) ||
    !Array.isArray(s.errors) ||
    !s.usage ||
    !Number.isInteger(s.usage.calls) ||
    !Number.isFinite(s.usage.latencyMs) ||
    s.errors.some(
      (e) =>
        !e ||
        typeof e.code !== 'string' ||
        typeof e.message !== 'string' ||
        (e.role !== undefined && !CHIEF_ROLES.includes(e.role)) ||
        !DELIBERATION_STAGES.includes(e.stage)
    )
  )
    throw invalid();
  for (const [items, validate] of [
    [s.initialPositions, validateChiefPosition],
    [s.crossReview, validateChiefResponse]
  ] as const) {
    if (
      items.length > 5 ||
      new Set(items.map((i) => i?.role)).size !== items.length ||
      items.some(
        (i) =>
          !i ||
          !CHIEF_ROLES.includes(i.role) ||
          !Number.isFinite(i.confidence) ||
          i.confidence < 0 ||
          i.confidence > 1 ||
          !validate(i.role, i).ok ||
          (i.substituted !== undefined && typeof i.substituted !== 'boolean')
      )
    )
      throw invalid();
  }
  if (
    s.finalBrief &&
    (!validateFinalBrief(s.finalBrief).ok ||
      !Number.isFinite(s.finalBrief.confidence) ||
      s.finalBrief.confidence < 0 ||
      s.finalBrief.confidence > 1)
  )
    throw invalid();
  if (
    ['ready', 'degraded'].includes(s.status) &&
    (!s.finalBrief || s.initialPositions.length !== 5 || s.crossReview.length !== 5)
  )
    throw invalid();
  if (s.planId !== undefined && (typeof s.planId !== 'string' || !s.planId)) throw invalid();
  return s;
}
