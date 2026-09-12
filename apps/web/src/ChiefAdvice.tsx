import type { ApproveRecommendationResponse, Recommendation } from './contract';

export interface AdviceState {
  items: Recommendation[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string;
}
export const emptyAdvice: AdviceState = { items: [], status: 'idle', error: '' };

/** Request generations prevent advice from an earlier world/reset replacing newer advice. */
export class AdviceRequests {
  private generation = 0;
  invalidate() {
    this.generation += 1;
  }
  async load(request: () => Promise<Recommendation[]>, publish: (state: AdviceState) => void) {
    const generation = ++this.generation;
    publish({ items: [], status: 'loading', error: '' });
    try {
      const items = await request();
      if (generation === this.generation) publish({ items, status: 'ready', error: '' });
    } catch {
      if (generation === this.generation)
        publish({
          items: [],
          status: 'error',
          error:
            'Cloud reasoning is unavailable. No new advice was received. The deterministic simulation and local report queue remain usable.'
        });
    }
  }
}

/** Outcome of the most recent approval, keyed by recommendation id. */
export type ApprovalOutcomes = Record<string, ApproveRecommendationResponse>;

export function ChiefAdvice({
  advice,
  revision,
  online,
  onRefresh,
  onApprove,
  approvals,
  approving,
  disabled
}: {
  advice: AdviceState;
  revision: number;
  online: boolean;
  onRefresh: () => void;
  onApprove: (recommendationId: string, analyzedRevision: number) => void;
  approvals: ApprovalOutcomes;
  approving: string;
  disabled: boolean;
}) {
  return (
    <>
      <p className="muted">
        Chiefs advise; the deterministic engine validates operator-approved plans. Advice is never
        an execution receipt.
      </p>
      {!online && (
        <p className="amber">
          Device offline. Gemini requires a cloud connection; displayed advice is cached. Reports
          can still be queued locally.
        </p>
      )}
      {advice.status === 'loading' && (
        <p role="status">Loading chief advice… No new recommendation has been executed.</p>
      )}
      {advice.status === 'error' && (
        <p role="alert" className="amber">
          {advice.error}
        </p>
      )}
      {advice.items.map(({ recommendation: r, source, analyzedRevision }) => {
        const stale = analyzedRevision !== revision;
        return (
          <article key={r.id}>
            <strong>
              {r.agent.replaceAll('_', ' ')}{' '}
              <span className="tag">
                {source.provider === 'gemini'
                  ? 'Gemini-generated'
                  : source.degraded
                    ? 'Scripted fallback'
                    : 'Scripted mock'}{' '}
                · {Math.round(r.confidence * 100)}%
              </span>
            </strong>
            <p>
              {r.summary}. {r.action}
            </p>
            <small>
              {source.model} · analyzed revision {analyzedRevision} ·{' '}
              {stale
                ? 'Stale advice — refresh before review'
                : r.status === 'pending'
                  ? 'Pending operator review — not executed'
                  : 'Advisory only — inspect plan status for execution'}
            </small>
            {source.degraded && (
              <p className="amber">
                Cloud reasoning unavailable; this recommendation is a scripted fallback.
              </p>
            )}
            {source.warning && <small>{source.warning}</small>}
            {r.proposedAction ? (
              <div className="advice-approve">
                <button
                  disabled={disabled || stale || approving === r.id || r.status !== 'pending'}
                  onClick={() => onApprove(r.id, analyzedRevision)}
                >
                  {approving === r.id ? 'Approving…' : 'Approve — request a plan'}
                </button>
                <small>
                  Approving asks the deterministic engine for a <strong>proposed</strong> plan. It
                  does not dispatch: review the plan and approve it separately to commit units.
                </small>
              </div>
            ) : (
              <small>Advisory only — no engine action; act through the operator controls.</small>
            )}
            {approvals[r.id] &&
              (approvals[r.id]?.refusal ? (
                <p role="alert" className="amber">
                  Not executed ({approvals[r.id]?.refusal?.code}):{' '}
                  {approvals[r.id]?.refusal?.message}
                </p>
              ) : (
                <p role="status" className="advice-approved">
                  Engine accepted the request at revision {approvals[r.id]?.revision}. A proposed
                  plan is waiting for your review — nothing is dispatched yet.
                </p>
              ))}
          </article>
        );
      })}
      {advice.status === 'idle' && <p>No chief advice loaded.</p>}
      <button disabled={disabled || !online || advice.status === 'loading'} onClick={onRefresh}>
        Refresh chief advice
      </button>
    </>
  );
}
