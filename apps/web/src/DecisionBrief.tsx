import {
  buildGlossary,
  humanizeCapability,
  type DeliberationSession,
  type ProvenanceSummary,
  type Scenario
} from '@rescuemesh/shared';

/**
 * The answer to "what should we do now", shown BEFORE the full debate.
 *
 * A judge should understand the situation, the recommended actions, what is
 * still uncovered and the decision they must make, without scrolling past ten
 * discussion cards first.
 *
 * Every identifier is rendered through the shared glossary, so no internal id
 * reaches the operator.
 */

export interface DecisionBriefProps {
  session: DeliberationSession;
  scenario: Scenario;
  provenance: ProvenanceSummary;
  planId?: string;
  busy: boolean;
  stale: boolean;
  onApprove: () => void;
  onAlternate: () => void;
}

export function DecisionBrief({
  session,
  scenario,
  provenance,
  planId,
  busy,
  stale,
  onApprove,
  onAlternate
}: DecisionBriefProps) {
  const brief = session.finalBrief;
  if (!brief) return null;
  const g = buildGlossary(scenario);
  const plan =
    scenario.plans.find((p) => p.id === planId) ??
    scenario.plans.find((p) => p.status === 'proposed');

  const arrival = (incidentId: string, resourceId: string): string => {
    const resource = scenario.resources.find((r) => r.id === resourceId);
    const route = scenario.routes.find(
      (r) => r.fromId === resource?.homeFacilityId && r.toId === incidentId
    );
    return route ? `modeled arrival ${route.travelMinutes} minutes` : 'modeled arrival not routed';
  };

  const gaps = (plan?.shortfalls ?? []).map((s) => ({
    incident: g.label(s.incidentId),
    missing: s.missingCapabilities.map(humanizeCapability)
  }));

  return (
    <section className="decision-brief" aria-labelledby="decision-brief-title">
      <header className="decision-brief-head">
        <h2 id="decision-brief-title">Recommended response plan</h2>
        <span className="decision-brief-tag">
          Engine-validated · candidate · human approval required
        </span>
      </header>

      <p className="decision-brief-provenance">{provenance.headline}</p>

      <div className="decision-brief-grid">
        <div>
          <h3>Situation</h3>
          <p>{g.humanize(brief.situationSummary)}</p>
        </div>

        <div>
          <h3>Immediate actions</h3>
          {plan && plan.assignments.length > 0 ? (
            <ol className="decision-actions">
              {plan.assignments.map((a) => (
                <li key={a.id}>
                  Send <strong>{a.resourceIds.map((id) => g.label(id)).join(' and ')}</strong> to{' '}
                  <strong>{g.label(a.incidentId)}</strong>,{' '}
                  {arrival(a.incidentId, a.resourceIds[0] ?? '')}
                  {a.destinationFacilityId
                    ? `, transporting to ${g.label(a.destinationFacilityId)}`
                    : ''}
                  .
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">
              No candidate plan yet. Generate one to see the recommended assignments.
            </p>
          )}
        </div>

        <div>
          <h3>Why this plan</h3>
          <ul>
            {brief.pointsOfAgreement.slice(0, 3).map((point: string) => (
              <li key={point}>{g.humanize(point)}</li>
            ))}
            {plan && <li>{g.humanize(plan.rationale)}</li>}
          </ul>
        </div>

        <div>
          <h3>Remaining gaps</h3>
          {gaps.length === 0 ? (
            <p className="green">Every active incident has at least one unit assigned.</p>
          ) : (
            <>
              <p className="amber">
                {gaps.length === 1
                  ? 'One incident still needs additional support.'
                  : `${spellOut(gaps.length)} incidents still need additional support.`}
              </p>
              <ul>
                {gaps.map((gap) => (
                  <li key={gap.incident}>
                    <strong>{gap.incident}</strong> — no unit available for {listWords(gap.missing)}
                    .
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {brief.unresolvedDisputes.length > 0 && (
        <div className="decision-dispute">
          <h3>Key disagreement requiring human judgement</h3>
          <ul>
            {brief.unresolvedDisputes.map((d: string) => (
              <li key={d}>{g.humanize(d)}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="decision-actions-row">
        <button
          className="approve-primary"
          disabled={busy || stale || !plan || plan.status !== 'proposed'}
          onClick={onApprove}
        >
          Approve and dispatch this plan
        </button>
        <button className="secondary" disabled={busy || stale} onClick={onAlternate}>
          Simulate alternate plan
        </button>
        <p className="decision-approval-note">
          Approval assigns the listed simulated resources. Gemini cannot dispatch them.
        </p>
      </div>
      {stale && (
        <p className="amber">
          The exercise changed after this advice was produced. Re-run the deliberation before
          approving.
        </p>
      )}
    </section>
  );
}

const spellOut = (n: number): string =>
  ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][n] ?? String(n);

const listWords = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? 'the required capability')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
