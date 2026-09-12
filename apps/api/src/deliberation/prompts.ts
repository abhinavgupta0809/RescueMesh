import type { AgentRole, ChiefPosition, Scenario } from '@rescuemesh/shared';
import { DELIBERATION_BOUNDS, glossaryLines } from '@rescuemesh/shared';
import { roleBriefText, ROLE_TITLES } from '../adapters/prompts.js';

/**
 * Prompts for the three deliberation rounds.
 *
 * Every prompt asks for a SHORT PUBLIC STATEMENT only. None asks for reasoning
 * steps, scratch work, or internal monologue: the transcript we display is the
 * answer itself, not a window into how it was produced.
 */

const GUARD = [
  'This is a training exercise on synthetic data. Your output is advisory: a human',
  'commander approves every plan and nothing you write changes world state.',
  '',
  'WRITING RULES — these matter as much as the content:',
  '- Plain English only. Use facility names ("Allegheny General Hospital") and unit',
  '  callsigns ("Ambulance 21"), never internal identifiers like inc-parkway, h-agh,',
  '  amb-21 or p-zone1. The brief lists a human name beside every identifier; use it.',
  '- Expand an abbreviation the first time you use it, e.g. "advanced life support".',
  '- ONE SHORT SENTENCE per bullet. Under 15 words. No sub-clauses.',
  '- Do not restate the whole situation in every section.',
  '- Write only your short public position. Do not include reasoning steps,',
  '  internal deliberation, or any text outside the JSON object.'
].join('\n');

const ROLE_BRIEFS: Record<AgentRole, string> = {
  incident_commander: 'You set overall priority across incidents and flag inter-agency conflicts.',
  medical_chief: 'You match casualties to hospital capacity and keep transport in reserve.',
  police_chief: 'You own scene access, traffic control, and evacuation routing.',
  rescue_chief: 'You own water rescue, extrication, and required rescue capabilities.',
  logistics_chief: 'You own supply movement, staging, and facility load balancing.'
};

const B = DELIBERATION_BOUNDS;

export const initialPrompt = (role: AgentRole, scenario: Scenario) => ({
  system: [
    `You are the ${ROLE_TITLES[role]} in the RescueMesh flood-response exercise.`,
    ROLE_BRIEFS[role],
    GUARD,
    'Give your opening position on the situation below.',
    'Reply with a single JSON object using exactly these keys:',
    '{"situationSummary": ONE OR TWO short sentences, under 240 characters total,',
    '"topPriorities": at most 3 bullets, "risks": at most 3 bullets, "proposedActions":',
    'at most 3 bullets, "confidence": number between 0 and 1}.',
    'Every bullet is one short sentence. Stay inside your own role.',
    'Name only places, facilities and units that appear in the brief.'
  ].join('\n'),
  user:
    `Names to use in your prose (never the identifier on the left):\n${glossaryLines(scenario)}\n\n` +
    `World state (frozen snapshot):\n${roleBriefText(role, scenario)}\n\n` +
    'Respond with the JSON object only.'
});

/** Concise digest of the other four positions. Never the full transcript. */
export const positionsDigest = (positions: ChiefPosition[], exclude: AgentRole): string =>
  positions
    .filter((position) => position.role !== exclude)
    .map(
      (position) =>
        `${ROLE_TITLES[position.role]}: ${position.situationSummary}\n` +
        `  priorities: ${position.topPriorities.join('; ') || 'none'}\n` +
        `  actions: ${position.proposedActions.join('; ') || 'none'}`
    )
    .join('\n');

export const crossReviewPrompt = (
  role: AgentRole,
  scenario: Scenario,
  positions: ChiefPosition[]
) => ({
  system: [
    `You are the ${ROLE_TITLES[role]} in the RescueMesh flood-response exercise.`,
    ROLE_BRIEFS[role],
    GUARD,
    'You have read the other chiefs’ opening positions. State where you agree, where you',
    'object, and how your own priority changes as a result. Be specific and brief.',
    'Reply with a single JSON object using exactly these keys:',
    `{"agreements": at most ${B.maxAgreements} bullets, "objections": at most`,
    `${B.maxObjections} bullets (empty if you have none), "revisedPriority": one short`,
    'sentence, "recommendation": one short sentence, "confidence": number 0-1}.',
    'Each bullet is one short sentence, under 15 words.',
    'Disagree only where you genuinely disagree. Do not restate the situation.'
  ].join('\n'),
  user:
    `Names to use in your prose:\n${glossaryLines(scenario)}\n\n` +
    `Other chiefs' opening positions:\n${positionsDigest(positions, role)}\n\n` +
    `Your own world-state slice:\n${roleBriefText(role, scenario)}\n\n` +
    'Respond with the JSON object only.'
});

export const synthesisPrompt = (
  scenario: Scenario,
  positions: ChiefPosition[],
  responses: {
    role: AgentRole;
    revisedPriority: string;
    recommendation: string;
    objections: string[];
  }[],
  incidentIds: string[]
) => ({
  system: [
    'You are the Incident Commander in the RescueMesh flood-response exercise.',
    GUARD,
    'You have both rounds of the deliberation. Produce ONE final operational brief that a',
    'human commander will review and approve or reject. Name genuine disagreements rather',
    'than smoothing them over.',
    'Reply with a single JSON object using exactly these keys:',
    '{"situationSummary": TWO short sentences, under 240 characters total,',
    `"pointsOfAgreement": at most ${B.maxPointsOfAgreement} bullets, "unresolvedDisputes": at`,
    `most ${B.maxUnresolvedDisputes} bullets (empty if genuinely none), "orderedPriorities":`,
    `1-${B.maxOrderedPriorities} bullets in priority order, "proposedActions": at most`,
    `${B.maxProposedActions} bullets, "rationale": THREE short sentences at most,`,
    '"confidence": number 0-1}.',
    'Every bullet is one short sentence. Name places and units in plain English.',
    `The brief covers these incidents: ${incidentIds.join(', ') || 'none'}.`
  ].join('\n'),
  user:
    `Round 1 — opening positions:\n${positionsDigest(positions, 'incident_commander' as AgentRole)}\n\n` +
    `Round 2 — cross-review:\n${responses
      .map(
        (r) =>
          `${ROLE_TITLES[r.role]}: revised priority — ${r.revisedPriority}; recommends — ${r.recommendation}` +
          (r.objections.length > 0 ? `; objects — ${r.objections.join('; ')}` : '')
      )
      .join('\n')}\n\n` +
    `Names to use in your prose:\n${glossaryLines(scenario)}\n\n` +
    `Current world state:\n${roleBriefText('incident_commander', scenario)}\n\n` +
    'Respond with the JSON object only.'
});

/**
 * The single bounded format-repair prompt.
 *
 * Compact by design: it carries only what is needed to recreate the
 * contribution — the role, the frozen brief, and the exact shape required. It
 * does NOT paste the broken reply back, because a truncated reply invites the
 * model to continue it rather than restate it cleanly.
 */
export const repairPrompt = (
  role: AgentRole,
  scenario: Scenario,
  stage: 'initial' | 'review' | 'synthesis',
  fault: string
) => ({
  system: [
    `You are the ${ROLE_TITLES[role]} in the RescueMesh flood-response exercise.`,
    `Your previous reply could not be used: ${fault}`,
    'Reply again, and this time keep it very short.',
    'Hard limits: situation summary under 200 characters; every bullet one short',
    'sentence under 12 words; at most 3 bullets per list.',
    'Plain English only — facility names and unit callsigns, never internal identifiers.',
    'Output the JSON object and nothing else. No preamble, no code fence, no commentary.'
  ].join('\n'),
  user:
    `Names to use:\n${glossaryLines(scenario)}\n\n` +
    `Situation:\n${roleBriefText(role, scenario)}\n\n` +
    `Produce the ${stage === 'synthesis' ? 'final brief' : stage === 'review' ? 'cross-review response' : 'opening position'} JSON object only.`
});
