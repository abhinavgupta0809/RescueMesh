import { DELIBERATION_BOUNDS } from '@rescuemesh/shared';

/**
 * Response schemas for each deliberation stage.
 *
 * `responseMimeType: application/json` alone only asks for JSON; it does not
 * bound length or shape, which is how a chief produced a 400-character
 * situationSummary that ran past the output cap and arrived truncated. A schema
 * constrains the model to exactly the fields the validators accept.
 *
 * Kept deliberately consistent with `validateChiefPosition`,
 * `validateChiefResponse` and `validateFinalBrief` — the schema narrows what is
 * asked for, it never replaces validation.
 */

const B = DELIBERATION_BOUNDS;

const shortString = { type: 'STRING' as const };

export const CHIEF_POSITION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    situationSummary: shortString,
    topPriorities: { type: 'ARRAY', items: shortString, minItems: 1, maxItems: B.maxTopPriorities },
    risks: { type: 'ARRAY', items: shortString, maxItems: B.maxRisks },
    proposedActions: { type: 'ARRAY', items: shortString, maxItems: B.maxProposedActions },
    confidence: { type: 'NUMBER' }
  },
  required: ['situationSummary', 'topPriorities', 'risks', 'proposedActions', 'confidence'],
  propertyOrdering: ['situationSummary', 'topPriorities', 'risks', 'proposedActions', 'confidence']
} as const;

export const CHIEF_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    agreements: { type: 'ARRAY', items: shortString, maxItems: B.maxAgreements },
    objections: { type: 'ARRAY', items: shortString, maxItems: B.maxObjections },
    revisedPriority: shortString,
    recommendation: shortString,
    confidence: { type: 'NUMBER' }
  },
  required: ['agreements', 'objections', 'revisedPriority', 'recommendation', 'confidence'],
  propertyOrdering: ['agreements', 'objections', 'revisedPriority', 'recommendation', 'confidence']
} as const;

export const FINAL_BRIEF_SCHEMA = {
  type: 'OBJECT',
  properties: {
    situationSummary: shortString,
    pointsOfAgreement: { type: 'ARRAY', items: shortString, maxItems: B.maxPointsOfAgreement },
    unresolvedDisputes: { type: 'ARRAY', items: shortString, maxItems: B.maxUnresolvedDisputes },
    orderedPriorities: {
      type: 'ARRAY',
      items: shortString,
      minItems: 1,
      maxItems: B.maxOrderedPriorities
    },
    proposedActions: { type: 'ARRAY', items: shortString, maxItems: B.maxProposedActions },
    rationale: shortString,
    confidence: { type: 'NUMBER' }
  },
  required: [
    'situationSummary',
    'pointsOfAgreement',
    'unresolvedDisputes',
    'orderedPriorities',
    'proposedActions',
    'rationale',
    'confidence'
  ],
  propertyOrdering: [
    'situationSummary',
    'pointsOfAgreement',
    'unresolvedDisputes',
    'orderedPriorities',
    'proposedActions',
    'rationale',
    'confidence'
  ]
} as const;

export type ResponseSchema =
  typeof CHIEF_POSITION_SCHEMA | typeof CHIEF_RESPONSE_SCHEMA | typeof FINAL_BRIEF_SCHEMA;
