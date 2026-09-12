import type { AgentRole, ChiefPosition, Scenario } from '@rescuemesh/shared';
import { DELIBERATION_BOUNDS } from '@rescuemesh/shared';
import { roleBriefText, ROLE_TITLES } from '../adapters/prompts.js';

/**
 * Prompts for the three deliberation rounds.
 *
 * Every prompt asks for a SHORT PUBLIC STATEMENT only. None asks for reasoning
 * steps, scratch work, or internal monologue: the transcript we display is the
 * answer itself, not a window into how it was produced.
 */

const GUARD = [
  'This is a training exercise on synthetic data. It is not a real emergency and',
  'your output is advisory: a human commander approves every plan, and nothing you',
  'write changes world state. Never invent entity IDs. All capacities and travel',
  'times shown are modeled for the exercise.',
  'Write only your short public position. Do not include reasoning steps, internal',
  'deliberation, or any text outside the JSON object.'
].join(' ');

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
    `{"situationSummary": string (max ${B.situationSummaryMaxLength} chars, what matters from`,
    'your role), "topPriorities": array of at most 3 short strings, "risks": array of at most 3',
    'short strings, "proposedActions": array of at most 3 short strings, "confidence": number',
    'between 0 and 1}.',
    'Stay inside your own role. Reference only IDs present in the brief.'
  ].join('\n'),
  user: `World state (frozen snapshot):\n${roleBriefText(role, scenario)}\n\nRespond with the JSON object only.`
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
    `{"agreements": array of at most ${B.maxAgreements} short strings, "objections": array of at`,
    `most ${B.maxObjections} short strings (empty if you have none), "revisedPriority": string`,
    '(max 200 chars), "recommendation": string (max 200 chars), "confidence": number 0-1}.',
    'Disagree only where you actually disagree. Do not restate the whole situation.'
  ].join('\n'),
  user:
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
    `{"situationSummary": string (max ${B.situationSummaryMaxLength} chars),`,
    `"pointsOfAgreement": array of at most ${B.maxPointsOfAgreement} short strings,`,
    `"unresolvedDisputes": array of at most ${B.maxUnresolvedDisputes} short strings (empty if`,
    `genuinely none), "orderedPriorities": array of 1-${B.maxOrderedPriorities} short strings in`,
    `priority order, "proposedActions": array of at most ${B.maxProposedActions} short strings,`,
    `"rationale": string (max ${B.rationaleMaxLength} chars), "confidence": number 0-1}.`,
    `Valid incident IDs: ${incidentIds.join(', ') || 'none'}. Reference no others.`
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
    `Current world state:\n${roleBriefText('incident_commander', scenario)}\n\n` +
    'Respond with the JSON object only.'
});
