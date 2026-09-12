import {
  type DeliberationSession,
  type DisasterSpecification,
  type Scenario
} from '@rescuemesh/shared';
import { CHIEF_ROLES } from './deliberation-contract';
import { FIXTURE_MODEL } from './deliberation-fixture';
import { STALE_MESSAGE, isDeliberating, type DeliberationView } from './deliberation-runner';
import { ExerciseBuilder } from './ExerciseBuilder';
import { DisasterBadge } from './disaster-ui';
import './deliberation.css';

export const roleName = (role: string) =>
  role
    .split('_')
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
const stages = (scripted: boolean) => [
  'Deterministic scenario',
  scripted ? 'Scripted deliberation' : 'Gemini deliberation',
  'Cross-review',
  'Incident Commander synthesis',
  'Engine-validated plan',
  'Human approval required'
];
function Statements({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">None reported.</p>
      )}
    </div>
  );
}
function Provenance({
  session,
  fallback = false,
  confidence,
  stale
}: {
  session: DeliberationSession;
  fallback?: boolean;
  confidence?: number;
  stale: boolean;
}) {
  const scripted = fallback || session.source.provider === 'scripted';
  const degraded = scripted || session.source.degraded || session.errors.length > 0;
  return (
    <div className="deliberation-provenance">
      <strong className={scripted ? 'amber' : 'green'}>
        {scripted ? 'Scripted fallback' : 'Gemini'}
      </strong>
      <span>
        Model:{' '}
        {scripted && session.source.provider === 'gemini' ? FIXTURE_MODEL : session.source.model}
      </span>
      <span>
        Scenario revision {session.scenarioRevision} · {stale ? 'Stale' : 'Frozen snapshot'}
      </span>
      {confidence !== undefined && <span>Confidence {Math.round(confidence * 100)}%</span>}
      {degraded && (
        <span className="amber">
          Degraded warning:{' '}
          {scripted
            ? 'Recorded exercise content; not live Gemini analysis.'
            : session.source.warning || 'Some contributions use recorded fallback.'}
        </span>
      )}
      {scripted && session.source.provider === 'gemini' && (
        <span>Attempted provider: Gemini · {session.source.model}</span>
      )}
    </div>
  );
}

export function Deliberation({
  view,
  scenario,
  disasters,
  acknowledgedDisasters,
  disabled,
  online,
  onDisastersChange,
  onSimulate,
  onResume
}: {
  view: DeliberationView;
  scenario: Scenario;
  disasters: DisasterSpecification[];
  acknowledgedDisasters: DisasterSpecification[];
  disabled: boolean;
  online: boolean;
  onDisastersChange: (disasters: DisasterSpecification[]) => void;
  onSimulate: () => void;
  onResume: () => void;
}) {
  const s = view.session;
  const stale = view.stale || s?.status === 'stale';
  const active = isDeliberating(view);
  const stageLabels = stages(s?.source.provider === 'scripted');
  const stage = !s
    ? -1
    : view.phase === 'done' && !stale && s.planId
      ? 5
      : view.phase === 'planning'
        ? 4
        : ['triggered', 'initial_analysis', 'cross_review', 'synthesis', 'validating'].indexOf(
            s.status
          );
  return (
    <section className="panel deliberation-panel" aria-labelledby="deliberation-title">
      <header className="panel-heading deliberation-heading">
        <div>
          <h2 id="deliberation-title">Five-chief deliberation</h2>
          <small>
            Gemini deliberation in API mode · scripted deliberation in local mock · deterministic
            engine remains in control
          </small>
        </div>
      </header>
      <ExerciseBuilder
        scenario={scenario}
        disasters={disasters}
        disabled={disabled || active || view.phase === 'error' || !online}
        starting={active}
        onChange={onDisastersChange}
        onSubmit={onSimulate}
      />
      <p className="deliberation-intro">
        Simulate submits one atomic synthetic exercise. The engine creates all selected incidents,
        freezes one revision, then the five chiefs deliberate. Review the separate engine-validated
        plan; human approval is required before assignments change.
      </p>
      {!online && (
        <p className="amber">
          Cloud reasoning is unavailable while this device is offline. Gemini does not work offline;
          field reports can still be queued.
        </p>
      )}
      <div role="status" className="deliberation-status">
        {view.phase === 'starting'
          ? 'Requesting deterministic disaster trigger. Waiting for backend acknowledgement…'
          : stale
            ? STALE_MESSAGE
            : view.error
              ? 'Deliberation needs attention. No execution confirmed.'
              : s
                ? `${stageLabels[Math.max(stage, 0)]}${s.status === 'degraded' ? ' · Scripted fallback contributions' : ''}`
                : 'Ready to simulate. No cloud request is made until you ask for advice.'}
      </div>
      {view.error && !stale && (
        <div role="alert" className="deliberation-error">
          <p>{view.error}</p>
          <p>
            Resume to check existing work without starting another disaster. If recovery fails,
            reset the scenario before starting a new session.
          </p>
          <button disabled={disabled || active || !online} onClick={onResume}>
            Resume existing session
          </button>
        </div>
      )}
      {s && (
        <>
          <div className="acknowledged-exercise">
            <strong>Deterministic scenario created · revision {s.scenarioRevision}</strong>
            <span>Synthetic exercise</span>
            <div>
              {acknowledgedDisasters.map((disaster, index) => (
                <DisasterBadge
                  disaster={disaster}
                  zones={scenario.zones}
                  key={`${disaster.kind}-${disaster.zoneId}-${index}`}
                />
              ))}
            </div>
          </div>
          <ol className="deliberation-stages" aria-label="Deliberation timeline">
            {stageLabels.map((label, index) => (
              <li
                key={label}
                aria-current={stage === index ? 'step' : undefined}
                className={stage > index ? 'complete' : stage === index ? 'current' : ''}
              >
                <span>{index + 1}</span>
                {label}
                <small>
                  {stage > index ? 'Complete' : stage === index ? 'Current' : 'Pending'}
                </small>
              </li>
            ))}
          </ol>
          {view.slow && active && (
            <p className="amber">
              {s.status === 'synthesis'
                ? 'Commander synthesis is taking longer than usual.'
                : 'Chief deliberation is taking longer than usual.'}{' '}
              Status reads do not make new Gemini calls. Deterministic controls remain usable.
            </p>
          )}
          {s.source.warning && <p className="amber">{s.source.warning}</p>}
          {s.errors.length > 0 && (
            <ul className="deliberation-error" aria-label="Deliberation warnings">
              {s.errors.map((e, i) => (
                <li key={i}>
                  {e.role ? roleName(e.role) : 'Session'} · {e.stage} · {e.code}: {e.message}
                </li>
              ))}
            </ul>
          )}
          <h3>
            Initial positions <span className="muted">· advisory, not executable</span>
          </h3>
          <div className="chief-position-grid">
            {CHIEF_ROLES.map((role) => {
              const p = s.initialPositions.find((item) => item.role === role);
              return (
                <article
                  className="chief-position"
                  key={role}
                  aria-label={`${roleName(role)} initial position`}
                >
                  <h3>{roleName(role)}</h3>
                  {p ? (
                    <>
                      <Provenance
                        session={s}
                        fallback={!!p.substituted}
                        confidence={p.confidence}
                        stale={stale}
                      />
                      <h4>Initial position</h4>
                      <p>{p.situationSummary}</p>
                      <Statements title="Top priorities" items={p.topPriorities} />
                      <Statements title="Risks" items={p.risks} />
                      <Statements
                        title="Proposed actions · advice only"
                        items={p.proposedActions}
                      />
                    </>
                  ) : (
                    <p className="muted">
                      {stale || s.status === 'failed'
                        ? 'No position received.'
                        : 'Awaiting initial position…'}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
          <section className="deliberation-debate" aria-labelledby="debate-title">
            <h3 id="debate-title">Cross-review</h3>
            {s.crossReview.length ? (
              s.crossReview.map((r) => (
                <div className="debate-row" key={r.role}>
                  <div>
                    <h3>{roleName(r.role)}</h3>
                    <Provenance
                      session={s}
                      fallback={!!r.substituted}
                      confidence={r.confidence}
                      stale={stale}
                    />
                  </div>
                  <Statements title="Agreement" items={r.agreements} />
                  <Statements title="Objection" items={r.objections} />
                  <div>
                    <h4>Revised recommendation</h4>
                    <p>{r.revisedPriority}</p>
                    <p>{r.recommendation}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">
                Awaiting cross-review of the chiefs’ validated initial positions.
              </p>
            )}
          </section>
          <section className="commander-synthesis" aria-labelledby="synthesis-title">
            <h3 id="synthesis-title">
              Incident Commander synthesis <span className="muted">· final advisory brief</span>
            </h3>
            {s.finalBrief ? (
              <>
                <Provenance
                  session={s}
                  fallback={s.errors.some((e) => e.stage === 'synthesis')}
                  confidence={s.finalBrief.confidence}
                  stale={stale}
                />
                <p>{s.finalBrief.situationSummary}</p>
                <div className="synthesis-columns">
                  <Statements title="Points of agreement" items={s.finalBrief.pointsOfAgreement} />
                  <Statements title="Unresolved disputes" items={s.finalBrief.unresolvedDisputes} />
                  <Statements title="Ordered priorities" items={s.finalBrief.orderedPriorities} />
                </div>
                <Statements
                  title="Proposed actions · advice only"
                  items={s.finalBrief.proposedActions}
                />
                <p>{s.finalBrief.rationale}</p>
              </>
            ) : (
              <p className="muted">
                Awaiting the Incident Commander’s final brief. No executable plan is ready.
              </p>
            )}
          </section>
          <div className="engine-plan-boundary">
            <strong>Engine-validated plan · human approval required</strong>
            <p>
              The engine independently allocates resources from scenario state. Chief prose is not
              executed.
            </p>
            <p>
              {s.planId && view.phase === 'done' && !stale && !view.error
                ? `Candidate ${s.planId} is in the resource plan panel. Nothing is dispatched by deliberation; operator approval and engine validation are required.`
                : 'No current candidate plan confirmed. Approval is disabled until deliberation and deterministic plan generation finish.'}
            </p>
            <a href="#recommendations">Inspect resource plan, assignments and shortfalls →</a>
          </div>
        </>
      )}
    </section>
  );
}
