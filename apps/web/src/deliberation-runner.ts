import {
  isTerminalStatus,
  type DeliberationSession,
  type StartSimulationRequest
} from '@rescuemesh/shared';
import type { FrontendClient, Plan, Scenario } from './contract';

export const STALE_MESSAGE =
  'Scenario changed while the chiefs were deliberating. Run a new simulation to generate a current plan.';
export interface DeliberationView {
  phase: 'idle' | 'starting' | 'polling' | 'planning' | 'done' | 'error';
  session?: DeliberationSession;
  error: string;
  stale: boolean;
  slow: boolean;
}
export const emptyDeliberation: DeliberationView = {
  phase: 'idle',
  error: '',
  stale: false,
  slow: false
};
export const isDeliberating = (v: DeliberationView) =>
  ['starting', 'polling', 'planning'].includes(v.phase);
export function canApproveSession(v: DeliberationView, plan: Plan | undefined, revision: number) {
  return (
    v.phase === 'done' &&
    !v.stale &&
    !v.error &&
    !!v.session &&
    ['ready', 'degraded'].includes(v.session.status) &&
    !!v.session.finalBrief &&
    !!plan &&
    plan.id === v.session.planId &&
    plan.status === 'proposed' &&
    plan.basedOnRevision === revision
  );
}

/** Single flight, cancellable status reads. GET polling never requests chief advice. */
export class DeliberationRunner {
  view = emptyDeliberation;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private startedAt = 0;
  private request: StartSimulationRequest | undefined;
  private world: Scenario | undefined;
  private active?: FrontendClient;
  private refresh?: () => Promise<void>;
  constructor(
    private publish: (value: DeliberationView) => void,
    private interval = 1000,
    private timeout = 120000
  ) {}
  private emit(change: Partial<DeliberationView>) {
    this.view = { ...this.view, ...change };
    this.publish(this.view);
  }
  private stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.abort?.abort();
  }
  reset() {
    this.stop();
    this.request = undefined;
    this.world = undefined;
    // Partial updates must not retain an old session, including reused revision zero.
    this.view = { ...emptyDeliberation };
    this.publish(this.view);
  }
  dispose() {
    this.stop();
  }
  observe(world: Scenario) {
    this.world = world;
    const s = this.view.session;
    if (!s || this.view.stale || this.view.phase === 'planning') return;
    const plan = world.plans.find((p) => p.id === s.planId);
    const ownPlanRevision =
      plan &&
      (plan.basedOnRevision === world.revision ||
        (plan.status === 'approved' && plan.basedOnRevision + 1 === world.revision));
    if (s.scenarioRevision !== world.revision && !ownPlanRevision) {
      this.stop();
      this.emit({ stale: true, phase: 'done', error: STALE_MESSAGE });
    }
  }
  async start(
    client: FrontendClient,
    request: StartSimulationRequest,
    refresh: () => Promise<void>
  ) {
    if (isDeliberating(this.view) || this.view.phase === 'error') return;
    this.stop();
    this.active = client;
    this.refresh = refresh;
    this.request = { ...request, requestId: request.requestId ?? crypto.randomUUID() };
    this.view = { ...emptyDeliberation };
    await this.begin(true);
  }
  /** Recovery reuses the session or requestId: never silently starts another model session. */
  async resume() {
    if (isDeliberating(this.view) || this.view.stale || !this.active || !this.request) return;
    this.stop();
    await this.begin(!this.view.session);
  }
  private async begin(start: boolean) {
    const generation = this.generation;
    this.abort = new AbortController();
    this.startedAt = Date.now();
    this.emit({ phase: start ? 'starting' : 'polling', error: '', slow: false });
    try {
      const s = start
        ? await this.active!.startSimulation(this.request!, this.abort.signal)
        : await this.active!.simulation(this.view.session!.sessionId, this.abort.signal);
      if (generation !== this.generation) return;
      this.emit({ session: s, phase: 'polling' });
      await this.refresh!();
      if (generation !== this.generation) return;
      await this.accept(s, generation);
    } catch (e) {
      this.fail(e, generation);
    }
  }
  private fail(error: unknown, generation: number) {
    if (generation !== this.generation) return;
    if (error instanceof Error && 'code' in error && error.code === 'stale_session') {
      this.emit({ phase: 'done', stale: true, error: STALE_MESSAGE });
      return;
    }
    this.emit({
      phase: 'error',
      error: `${error instanceof Error ? error.message : 'Backend unavailable.'} No dispatch has been confirmed. Deterministic controls and the local report queue remain available.`
    });
  }
  private async accept(s: DeliberationSession, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.emit({ session: s, slow: Date.now() - this.startedAt >= 15000 });
    if (s.status === 'stale') {
      this.emit({ phase: 'done', stale: true, error: STALE_MESSAGE });
      return;
    }
    if (isTerminalStatus(s.status)) {
      if (s.status === 'failed') {
        this.fail(new Error('Deliberation failed. Review the session errors.'), generation);
        return;
      }
      this.emit({ phase: 'planning' });
      try {
        const withPlan = s.planId
          ? s
          : await this.active!.finalPlan(s.sessionId, this.abort!.signal);
        if (generation !== this.generation) return;
        this.emit({ session: withPlan });
        await this.refresh!();
        if (generation !== this.generation) return;
        this.emit({ phase: 'done', slow: false });
        if (this.world) this.observe(this.world);
      } catch (e) {
        this.fail(e, generation);
      }
      return;
    }
    this.timer = setTimeout(async () => {
      if (generation !== this.generation) return;
      if (Date.now() - this.startedAt >= this.timeout) {
        this.fail(
          new Error(
            'Status polling timed out. Resume this session to check its outcome without new Gemini calls.'
          ),
          generation
        );
        return;
      }
      try {
        const next = await this.active!.simulation(s.sessionId, this.abort!.signal);
        await this.accept(next, generation);
      } catch (e) {
        this.fail(e, generation);
      }
    }, this.interval);
  }
}
