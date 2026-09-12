/**
 * Failure classification for provider replies.
 *
 * The Logistics failure in production reported "Model reply contained no JSON
 * object" for a reply that visibly BEGAN as valid JSON and was cut off
 * mid-string. The `finishReason === 'MAX_TOKENS'` guard did not fire, so
 * truncation reached the extractor disguised as a syntax error.
 *
 * Truncation is therefore detected STRUCTURALLY — an unterminated string or
 * unbalanced braces — and `finishReason` is kept as corroborating evidence
 * rather than the sole signal.
 */

export type ReplyFault =
  | 'truncated_json'
  | 'malformed_json'
  | 'wrong_shape'
  | 'no_json'
  | 'blocked'
  | 'timeout'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth'
  | 'transport';

export interface ReplyDiagnosis {
  fault: ReplyFault;
  /** Short, human-readable. Safe to show an operator. */
  summary: string;
  /** Provider finishReason when one was reported. */
  finishReason?: string;
  /** True when one bounded format-repair attempt is worth making. */
  repairable: boolean;
}

/**
 * Scans for an unterminated JSON object: a reply that opens a brace or a string
 * and never closes it. This is what a cut-off model reply looks like, and it is
 * distinguishable from genuinely malformed syntax.
 */
export const looksTruncated = (raw: string): boolean => {
  const text = raw.trim();
  if (!text.startsWith('{') && !text.includes('{')) return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let opened = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      depth += 1;
      opened = true;
    } else if (char === '}') {
      depth -= 1;
    }
  }
  // Still inside a string, or braces never balanced: the reply stopped early.
  return opened && (inString || depth > 0);
};

/** Classifies a reply that failed to produce a valid artefact. */
export const diagnoseReply = (
  raw: string,
  options: { finishReason?: string; shapeReason?: string } = {}
): ReplyDiagnosis => {
  const finishReason = options.finishReason;
  const base = finishReason ? { finishReason } : {};

  if (options.shapeReason) {
    return {
      ...base,
      fault: 'wrong_shape',
      summary: `The reply was valid JSON but did not match the required shape: ${options.shapeReason}`,
      repairable: true
    };
  }
  if (finishReason === 'MAX_TOKENS' || looksTruncated(raw)) {
    return {
      ...base,
      fault: 'truncated_json',
      summary: 'The reply was cut off before the JSON object was complete.',
      repairable: true
    };
  }
  if (!raw.includes('{')) {
    return {
      ...base,
      fault: 'no_json',
      summary: 'The reply contained no JSON object at all.',
      repairable: true
    };
  }
  return {
    ...base,
    fault: 'malformed_json',
    summary: 'The reply contained JSON that could not be parsed.',
    repairable: true
  };
};

/** Diagnosis for a transport-level failure, where there is no reply body. */
export const diagnoseTransport = (
  stage: 'timeout' | 'http' | 'transport' | 'blocked' | 'shape',
  status: number | undefined,
  quotaExhausted: boolean
): ReplyDiagnosis => {
  if (stage === 'timeout') {
    return { fault: 'timeout', summary: 'The provider did not answer in time.', repairable: false };
  }
  if (stage === 'blocked') {
    return {
      fault: 'blocked',
      summary: 'The provider declined to answer this prompt.',
      repairable: false
    };
  }
  if (quotaExhausted) {
    return {
      fault: 'quota_exhausted',
      summary: 'The provider daily quota is exhausted.',
      repairable: false
    };
  }
  if (status === 401 || status === 403) {
    return { fault: 'auth', summary: 'The provider rejected the credential.', repairable: false };
  }
  if (status === 429) {
    return {
      fault: 'rate_limited',
      summary: 'The provider is rate limiting requests.',
      repairable: false
    };
  }
  return { fault: 'transport', summary: 'The provider could not be reached.', repairable: false };
};
