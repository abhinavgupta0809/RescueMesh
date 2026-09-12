import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DisasterSpecification } from '@rescuemesh/shared';
import { createClient, makeCommand, ApiError } from './api-client';
import { planProvenanceLabel } from './contract';
import type { Command, FieldReport, FrontendClient, Scenario } from './contract';
import { AdviceRequests, ChiefAdvice, emptyAdvice, type ApprovalOutcomes } from './ChiefAdvice';
import { readQueue, writeQueue } from './offline-queue';
import { OperatingMap } from './OperatingMap';
import { Deliberation } from './Deliberation';
import { DecisionBrief } from './DecisionBrief';
import { summarizeProvenance } from '@rescuemesh/shared';
import { defaultExercise } from './ExerciseBuilder';
import {
  DISASTER_PRESENTATION,
  DisasterBadge,
  DisasterIcon,
  disasterKindForIncident,
  humanizeZoneIds,
  zoneForIncident
} from './disaster-ui';
import {
  DeliberationRunner,
  canApproveSession,
  emptyDeliberation,
  isDeliberating
} from './deliberation-runner';

const kindNames = {
  ambulance: 'Ambulances',
  rescue_boat: 'Rescue teams',
  fire_engine: 'Fire engines',
  police_unit: 'Police units',
  supply_truck: 'Supply trucks'
};
const initialReport =
  'Around 40 people at the East End school need evacuation assistance and drinking water.';
const clock = (value: string) =>
  new Date(value).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/New_York'
  });
export function App() {
  const [mode, setMode] = useState<'mock' | 'api'>(
    import.meta.env.VITE_API_MODE === 'api' ? 'api' : 'mock'
  );
  const client = useRef<FrontendClient>(createClient(mode));
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const stateRef = useRef(scenario);
  stateRef.current = scenario;
  const [advice, setAdvice] = useState(emptyAdvice);
  const [deliberation, setDeliberation] = useState(emptyDeliberation);
  const [disasters, setDisasters] = useState<DisasterSpecification[]>(defaultExercise);
  const [submittedDisasters, setSubmittedDisasters] = useState<DisasterSpecification[]>([]);
  const runner = useRef<DeliberationRunner | null>(null);
  runner.current ??= new DeliberationRunner(setDeliberation);
  const [approvals, setApprovals] = useState<ApprovalOutcomes>({});
  const [approving, setApproving] = useState('');
  const adviceRequests = useRef(new AdviceRequests());
  const worldRead = useRef(0);
  const [stateFresh, setStateFresh] = useState(false);
  const [queue, setQueue] = useState<FieldReport[]>([]);
  const [queueReady, setQueueReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const locked = useRef(false);
  const [selectedZone, setSelectedZone] = useState('');
  const [selected, setSelected] = useState('');
  const [body, setBody] = useState(initialReport);
  const [edgeTab, setEdgeTab] = useState('Field reports');
  const [logTab, setLogTab] = useState('Global log');
  const [nav, setNav] = useState('Command center');
  const [online, setOnline] = useState(navigator.onLine);
  const [resetOpen, setResetOpen] = useState(false);
  const [lastSync, setLastSync] = useState('');
  const loadAdvice = useCallback((active: FrontendClient) => {
    if (active.mode === 'api' && !navigator.onLine) {
      adviceRequests.current.invalidate();
      setAdvice({
        items: [],
        status: 'error',
        error:
          'Cloud reasoning is unavailable while this device is offline. Reports can still be queued locally.'
      });
      return;
    }
    void adviceRequests.current.load(() => active.recommendations(), setAdvice);
  }, []);

  const refresh = useCallback(async (active: FrontendClient) => {
    const generation = ++worldRead.current;
    const value = await active.scenario();
    if (client.current !== active || generation !== worldRead.current) return;
    stateRef.current = value;
    setScenario(value);
    setStateFresh(true);
    setLastSync(clock(value.simulatedTime));
    runner.current!.observe(value);
  }, []);
  /**
   * Approving advice asks the engine for a PROPOSED plan. It is deliberately a
   * separate step from dispatching that plan, which still needs plan.approve.
   */
  const approveAdvice = useCallback(
    (recommendationId: string, analyzedRevision: number) => {
      setApproving(recommendationId);
      void client.current
        .approveAdvice(recommendationId, analyzedRevision)
        .then(async (outcome) => {
          setApprovals((current) => ({ ...current, [recommendationId]: outcome }));
          if (outcome.ok) {
            await refresh(client.current);
            loadAdvice(client.current);
          }
        })
        .catch((error: unknown) => {
          setApprovals((current) => ({
            ...current,
            [recommendationId]: {
              ok: false,
              recommendationId,
              revision: -1,
              refusal: {
                code: 'not_found',
                message:
                  error instanceof ApiError
                    ? error.message
                    : 'The approval could not be sent. Nothing was executed.'
              }
            }
          }));
        })
        .finally(() => setApproving(''));
    },
    // `refresh` and `loadAdvice` are stable useCallbacks; client is a ref.
    [loadAdvice, refresh]
  );
  useEffect(() => {
    const active = createClient(mode);
    client.current = active;
    runner.current!.reset();
    setDisasters(defaultExercise());
    setSubmittedDisasters([]);
    setScenario(null);
    adviceRequests.current.invalidate();
    setAdvice(emptyAdvice);
    setStateFresh(false);
    stateRef.current = null;
    setError('');
    setQueueReady(false);
    setSelected('');
    setSelectedZone('');
    setNotice('');
    try {
      setQueue(readQueue(localStorage, mode));
      setQueueReady(true);
    } catch (e) {
      setError(String(e));
    }
    setBusy('Loading operating picture');
    refresh(active)
      .catch((e) => {
        if (client.current === active) setError(String(e.message));
      })
      .finally(() => {
        if (client.current === active) setBusy('');
      });
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling || locked.current || !stateRef.current) return;
      polling = true;
      const generation = worldRead.current;
      try {
        const next = await active.poll(stateRef.current.revision);
        if (client.current !== active || locked.current || generation !== worldRead.current) return;
        setStateFresh(true);
        if (next) {
          stateRef.current = next;
          setScenario(next);
          setLastSync(clock(next.simulatedTime));
          runner.current!.observe(next);
        }
      } catch (e) {
        if (client.current === active && generation === worldRead.current) {
          setStateFresh(false);
          setError(e instanceof Error ? e.message : 'Polling failed.');
        }
      } finally {
        polling = false;
      }
    }, 3000);
    return () => {
      clearInterval(timer);
      adviceRequests.current.invalidate();
      runner.current!.dispose();
      worldRead.current += 1;
    };
  }, [mode, refresh, loadAdvice]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  function saveQueue(next: FieldReport[]) {
    if (!queueReady)
      throw new Error('Report storage is unavailable. The saved queue has not been overwritten.');
    try {
      writeQueue(localStorage, mode, next);
    } catch {
      throw new Error(
        'Device storage is full or unavailable. Report was not queued; keep your text and retry.'
      );
    }
    setQueue(next);
  }
  async function send(command: Command) {
    const response = await client.current.command(command);
    if (!response.ok) throw new ApiError(response.error.message, response.error.code);
    return response;
  }
  async function run(label: string, action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    worldRead.current += 1;
    adviceRequests.current.invalidate();
    setStateFresh(false);
    setAdvice(emptyAdvice);
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
      if (online || mode === 'mock') await refresh(client.current);
      setNotice(`${label} complete${mode === 'mock' ? ' · mock simulation' : ''}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      locked.current = false;
      setBusy('');
    }
  }
  const zone =
    scenario?.zones.find((z) => z.id === selectedZone) ??
    scenario?.zones.find((z) => z.id === 'zone-east') ??
    scenario?.zones.at(-1);
  const plan =
    (deliberation.session?.planId
      ? scenario?.plans.find((p) => p.id === deliberation.session!.planId)
      : undefined) ??
    scenario?.plans.find((p) => p.status === 'proposed') ??
    scenario?.plans.at(-1);
  const sessionBlocksPlan =
    deliberation.phase !== 'idle' &&
    !canApproveSession(deliberation, plan, scenario?.revision ?? -1);
  function simulate() {
    if (
      locked.current ||
      approving ||
      isDeliberating(runner.current!.view) ||
      (mode === 'api' && !online)
    )
      return;
    adviceRequests.current.invalidate();
    setAdvice(emptyAdvice);
    const active = client.current;
    const exercise = disasters.map((disaster) => ({ ...disaster }));
    setSubmittedDisasters(exercise);
    void runner.current!.start(active, { disasters: exercise }, () => refresh(active));
  }
  const bridge = scenario?.bridges[0];
  const available = scenario?.resources.filter((r) => r.status === 'available').length ?? 0;
  const detail =
    scenario?.facilities.find((f) => f.id === selected) ??
    scenario?.incidents.find((i) => i.id === selected);
  function act(label: string, command: Command) {
    void run(label, async () => {
      await send(command);
    });
  }
  async function submitReport() {
    if (!zone || !body.trim() || body.length > 4000) return;
    const report: FieldReport = {
      clientReportId: crypto.randomUUID(),
      zoneId: zone.id,
      body: body.trim(),
      capturedAt: new Date().toISOString(),
      syncState: 'queued'
    };
    saveQueue([...queue, report]); // Write ahead: an uncertain acknowledgement retains the same ID.
    if (zone.connectivity === 'offline' || !online) {
      setBody('');
      setEdgeTab('Sync queue');
      return;
    }
    try {
      const result = await send(makeCommand('report.submit', report));
      if (result.type === 'report.submit' && !result.data.queuedOffline) saveQueue(queue);
      setBody('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'zone_offline') {
        setBody('');
        setEdgeTab('Sync queue');
        return;
      }
      // It was saved before the request. Retry via sync with the existing ID,
      // rather than submitting the same text as a new report after a lost ACK.
      setBody('');
      setEdgeTab('Sync queue');
      throw e;
    }
  }
  async function sync() {
    if (!zone) return;
    if (zone.connectivity !== 'online')
      await send(makeCommand('zone.set_connectivity', { zoneId: zone.id, connectivity: 'online' }));
    const pending = queue.filter((r) => r.zoneId === zone.id);
    if (!pending.length) return;
    const result = await send(
      makeCommand('report.sync', {
        reports: pending.map(({ clientReportId, zoneId, body, capturedAt }) => ({
          clientReportId,
          zoneId,
          body,
          capturedAt
        }))
      })
    );
    if (result.type === 'report.sync') {
      const acknowledged = [...result.data.applied, ...result.data.duplicates].map(
        (r) => r.clientReportId
      );
      saveQueue(
        queue
          .filter((r) => !acknowledged.includes(r.clientReportId))
          .map((r) => {
            const rejected = result.data.rejected.find(
              (v) => v.clientReportId === r.clientReportId
            );
            return rejected
              ? {
                  ...r,
                  syncState: 'rejected',
                  rejectionReason: rejected.rejectionReason ?? 'Rejected by server.'
                }
              : r;
          })
      );
      if (result.data.rejected.length)
        throw new Error(
          `${result.data.rejected.length} report(s) rejected. Retained in the device queue for inspection.`
        );
    }
  }
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#command-center" onClick={() => setNav('Command center')}>
          <strong>
            Rescue<span>Mesh</span>
          </strong>
          <small>Coordinate. Adapt. Keep going.</small>
        </a>
        <nav aria-label="Main navigation">
          {['Command center', 'Assets', 'Incidents', 'Analytics', 'Communications'].map((item) => (
            <a
              key={item}
              className={nav === item ? 'active' : ''}
              href={`#${{ 'Command center': 'command-center', Assets: 'assets', Incidents: 'incidents', Analytics: 'recommendations', Communications: 'communications' }[item]}`}
              onClick={() => setNav(item)}
            >
              {item}
            </a>
          ))}
        </nav>
        <div className="connection">
          <strong className={mode === 'mock' ? 'amber' : error ? 'red' : 'green'}>
            {mode === 'mock' ? 'Mock simulation' : error ? 'API needs attention' : 'API mode'}
          </strong>
          <small>
            {online
              ? `Last state · ${lastSync || 'connecting'}`
              : 'Device offline · reports stay local'}
          </small>
        </div>
        <div className="clock">
          <small>EXERCISE CLOCK</small>
          <strong>{scenario ? clock(scenario.simulatedTime) : '—:—'}</strong>
        </div>
      </header>
      <div className="exercise">
        <span>
          EXERCISE ONLY{' '}
          <span className="muted">
            / All incidents, capacities, forecasts and travel estimates are synthetic.
          </span>
        </span>
        <label>
          Data source{' '}
          <select
            aria-label="Data source"
            disabled={!!busy}
            value={mode}
            onChange={(e) => setMode(e.target.value as 'mock' | 'api')}
          >
            <option value="mock">Local mock</option>
            <option value="api">Backend API</option>
          </select>
        </label>
        <button
          type="button"
          className="reset-persistent"
          aria-label="Reset exercise to its starting state"
          disabled={!!busy}
          onClick={() => setResetOpen(true)}
        >
          Reset exercise
        </button>
      </div>
      {error && (
        <div role="alert" className="message error">
          {error}
          <button disabled={!!busy} onClick={() => void run('Refresh', async () => {})}>
            Retry refresh
          </button>
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {busy || notice}
      </div>
      {!scenario ? (
        <section className="loading panel">
          <h2>{busy || 'Operating picture unavailable'}</h2>
          <p>
            {error
              ? 'Check the API or explicitly select Local mock to run the demo.'
              : 'Loading the synthetic Pittsburgh scenario…'}
          </p>
        </section>
      ) : (
        <>
          <div className="upper-grid" id="command-center">
            <aside className="sidebar panel">
              <h2>Zones</h2>
              <div className="zone-list">
                {scenario.zones.map((z, i) => (
                  <button
                    key={z.id}
                    className={`zone-button ${z.id === zone?.id ? 'selected' : ''} ${z.connectivity}`}
                    onClick={() => setSelectedZone(z.id)}
                  >
                    <span>
                      <strong>Zone {String.fromCharCode(65 + i)}</strong>
                      <small>{z.name}</small>
                    </span>
                    <span className={`status ${z.connectivity}`}>{z.connectivity}</span>
                  </button>
                ))}
              </div>
              <h2>Key metrics</h2>
              <Metric
                value={scenario.incidents.reduce((n, i) => n + i.peopleAtRisk, 0)}
                label="People at risk"
                color="blue"
              />
              <Metric
                value={scenario.incidents.filter((i) => i.status === 'active').length}
                label="Active incidents"
                color="red"
              />
              <Metric
                value={`${available} / ${scenario.resources.length}`}
                label="Units available"
                color="amber"
              />
              <Metric
                value={scenario.facilities
                  .filter((f) => f.kind === 'hospital')
                  .reduce((n, f) => n + f.syntheticCapacity - f.currentLoad, 0)}
                label="Hospital spaces"
                color="green"
              />
              <Metric
                value={scenario.routes.filter((r) => r.status === 'closed').length}
                label="Closed routes"
                color="red"
              />
              <Metric
                value={scenario.zones.filter((z) => z.connectivity === 'offline').length}
                label="Zones offline"
                color="red"
              />
              <div className="sidebar-foot">
                <span className="green">Deterministic exercise</span>
                <small>
                  State revision {scenario.revision}
                  <br />
                  {scenario.facilities.length} response facilities
                </small>
              </div>
            </aside>
            <section className="panel map-panel">
              <Heading title="Pittsburgh · Operating map" aside="SCHEMATIC" />
              <OperatingMap
                scenario={scenario}
                selected={selected}
                activeDisasters={deliberation.session ? submittedDisasters : []}
                onSelect={setSelected}
              />
              <div className="map-detail" aria-live="polite">
                {detail ? (
                  <>
                    <strong>{'name' in detail ? detail.name : detail.title}</strong>
                    <span>
                      {'syntheticCapacity' in detail
                        ? `${detail.kind.replaceAll('_', ' ')} · ${detail.currentLoad}/${detail.syntheticCapacity} synthetic load · ${detail.status}`
                        : `${detail.severity} · ${detail.peopleAtRisk} modeled people at risk · ${detail.description}`}
                    </span>
                  </>
                ) : (
                  <>
                    <strong>Shared operating picture</strong>
                    <span>
                      Select a facility or incident to inspect. Boundaries and routes are
                      approximate.
                    </span>
                  </>
                )}
              </div>
            </section>
            <div className="right-grid">
              <section className="panel incident-panel" id="incidents">
                <Heading title="Active incidents" aside={`${scenario.incidents.length} TOTAL`} />
                <div className="incident-list">
                  {scenario.incidents.map((incident, i) => {
                    const disasterKind = disasterKindForIncident(incident);
                    const incidentZone = zoneForIncident(incident.id, scenario.zones);
                    return (
                      <button
                        className={`incident-row ${disasterKind ? DISASTER_PRESENTATION[disasterKind].tone : ''} ${selected === incident.id ? 'selected' : ''}`}
                        key={incident.id}
                        onClick={() => setSelected(incident.id)}
                      >
                        <span className={`incident-number ${incident.severity}`}>
                          {disasterKind ? (
                            <DisasterIcon kind={disasterKind} />
                          ) : (
                            String(i + 1).padStart(2, '0')
                          )}
                        </span>
                        <span className="incident-copy">
                          <strong>{incident.title}</strong>
                          <small>{incident.address}</small>
                          {disasterKind && (
                            <small
                              className={`incident-disaster ${DISASTER_PRESENTATION[disasterKind].tone}`}
                            >
                              {DISASTER_PRESENTATION[disasterKind].label} ·{' '}
                              {incidentZone?.name ?? 'Modeled zone'}
                            </small>
                          )}
                        </span>
                        <span className={`tag ${incident.severity}`}>{incident.severity}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="panel resource-panel" id="assets">
                <Heading title="Resource availability" aside="SYNTHETIC" />
                <div className="resource-bars">
                  {Object.entries(kindNames).map(([kind, name]) => {
                    const units = scenario.resources.filter((r) => r.kind === kind);
                    const free = units.filter((r) => r.status === 'available').length;
                    return (
                      <div className={`resource-bar ${kind}`} key={kind}>
                        <div>
                          <strong>{name}</strong>
                          <span>
                            {free} / {units.length}
                          </span>
                        </div>
                        <progress
                          aria-label={`${name} available`}
                          value={free}
                          max={units.length || 1}
                        />
                      </div>
                    );
                  })}
                </div>
                <details>
                  <summary>Inspect {scenario.resources.length} units</summary>
                  {scenario.resources.map((r) => (
                    <div className="unit" key={r.id}>
                      <strong>{r.callsign}</strong>
                      <span className={r.status === 'available' ? 'green' : 'amber'}>
                        {r.status.replaceAll('_', ' ')}
                      </span>
                    </div>
                  ))}
                </details>
              </section>
              <section className="panel recommendation-panel" id="recommendations">
                <Heading
                  title="Resource recommendation"
                  aside={plan ? `ENGINE · ${plan.status}` : 'HUMAN REVIEW'}
                />
                {plan && (
                  <p className="plan-provenance">
                    Engine-validated plan · {planProvenanceLabel(plan.generatedBy)} · not
                    AI-generated
                  </p>
                )}
                {plan && deliberation.session && submittedDisasters.length > 0 && (
                  <div className="plan-exercise-context" aria-label="Final plan exercise context">
                    <strong>Synthetic exercise context</strong>
                    <div>
                      {submittedDisasters.map((disaster, index) => (
                        <DisasterBadge
                          disaster={disaster}
                          zones={scenario.zones}
                          key={`${disaster.kind}-${disaster.zoneId}-${index}`}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <div className="plan-content">
                  <div className="plan-summary">
                    {plan ? (
                      <>
                        <p>{plan.rationale}</p>
                        <ol>
                          {plan.assignments.map((a) => (
                            <li key={a.id}>
                              <strong>
                                {a.resourceIds
                                  .map(
                                    (id) => scenario.resources.find((r) => r.id === id)?.callsign
                                  )
                                  .join(', ')}
                              </strong>
                              <span>
                                {' '}
                                → {scenario.incidents.find((i) => i.id === a.incidentId)?.title}
                              </span>
                            </li>
                          ))}
                        </ol>
                        {plan.shortfalls.length > 0 && (
                          <p className="amber">
                            {plan.shortfalls.length} incident(s) have unmet needs. Review shortfalls
                            below.
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="plan-lead">
                          A coordinated response starts with a reviewed plan.
                        </p>
                        <p>
                          Generate a capability-matched proposal, inspect modeled impact, then
                          approve resource assignments.
                        </p>
                        <div className="plan-hint">
                          Available units are only assigned after your approval.
                        </div>
                      </>
                    )}
                  </div>
                  <div className="plan-actions">
                    {plan?.status === 'proposed' && <small>Human approval required</small>}
                    <button
                      className="primary"
                      disabled={
                        !!busy ||
                        sessionBlocksPlan ||
                        !stateFresh ||
                        (mode === 'api' && !online) ||
                        (!!plan &&
                          plan.status === 'proposed' &&
                          plan.basedOnRevision !== scenario.revision)
                      }
                      onClick={() =>
                        act(
                          plan?.status === 'proposed' ? 'Plan approval' : 'Plan proposal',
                          plan?.status === 'proposed'
                            ? makeCommand('plan.approve', { planId: plan.id }, scenario.revision)
                            : makeCommand('plan.propose', {})
                        )
                      }
                    >
                      {plan?.status === 'proposed' ? 'Approve Plan' : 'Generate Plan'}
                    </button>
                    <button
                      disabled={!!busy || isDeliberating(deliberation)}
                      onClick={() => {
                        runner.current!.reset();
                        act(
                          'Alternate plan simulation',
                          makeCommand('plan.propose', {
                            reserveUnitsPerKind: 0,
                            incidentIds: scenario.incidents
                              .filter((i) => i.status === 'active')
                              .map((i) => i.id)
                              .reverse()
                          })
                        );
                      }}
                    >
                      Simulate Alternate Plan
                    </button>
                    {plan?.status === 'proposed' && plan.basedOnRevision !== scenario.revision && (
                      <small className="amber">
                        Plan is stale. Simulate again to review current state.
                      </small>
                    )}
                  </div>
                </div>
                <h3 className="forecast-title">
                  Impact forecast <span>· synthetic, proposed assignments only</span>
                </h3>
                <div className="forecast">
                  <Forecast
                    label="Total travel"
                    value={plan ? `${plan.forecast.modeledTotalTravelMinutes} min` : '—'}
                  />
                  <Forecast
                    label="Unmet capabilities"
                    value={plan?.forecast.unmetCapabilityCount ?? '—'}
                  />
                  <Forecast
                    label="People reachable / 30m"
                    value={plan?.forecast.peopleReachableWithin30Min ?? '—'}
                  />
                  <Forecast
                    label="Units in plan"
                    value={plan?.assignments.reduce((n, a) => n + a.resourceIds.length, 0) ?? '—'}
                  />
                </div>
                <details className="chiefs">
                  <summary>
                    Five chiefs · rationale & provenance
                    {advice.status === 'loading'
                      ? ' · loading'
                      : advice.status === 'error'
                        ? ' · unavailable'
                        : advice.items.some((r) => r.analyzedRevision !== scenario.revision)
                          ? ' · stale advice'
                          : ''}
                    {plan?.shortfalls.length ? ` · ${plan.shortfalls.length} shortfalls` : ''}
                  </summary>
                  {plan?.shortfalls.map((s) => (
                    <p className="amber" key={s.incidentId}>
                      {scenario.incidents.find((i) => i.id === s.incidentId)?.title}:{' '}
                      {s.missingCapabilities.join(', ')}. {s.reason}
                    </p>
                  ))}
                  <ChiefAdvice
                    advice={advice}
                    revision={scenario.revision}
                    online={online}
                    disabled={!!busy || deliberation.phase !== 'idle'}
                    onRefresh={() => loadAdvice(client.current)}
                    onApprove={approveAdvice}
                    approvals={approvals}
                    approving={approving}
                  />
                </details>
              </section>
            </div>
          </div>
          {/* Decision first, debate second: a judge sees the plan before the
              ten discussion cards. */}
          {deliberation.session?.finalBrief && (
            <DecisionBrief
              session={deliberation.session}
              scenario={scenario}
              provenance={summarizeProvenance(deliberation.session)}
              {...(deliberation.session.planId ? { planId: deliberation.session.planId } : {})}
              busy={!!busy || !!approving}
              stale={deliberation.session.status === 'stale'}
              onApprove={() => {
                const proposed = scenario.plans.find((p) => p.status === 'proposed');
                if (!proposed) return;
                void run('Plan approval', async () => {
                  await send(makeCommand('plan.approve', { planId: proposed.id }));
                });
              }}
              onAlternate={() => {
                void run('Plan proposal', async () => {
                  await send(makeCommand('plan.propose', {}));
                });
              }}
            />
          )}
          <Deliberation
            view={deliberation}
            scenario={scenario}
            disasters={disasters}
            acknowledgedDisasters={deliberation.session ? submittedDisasters : []}
            disabled={!!busy || !!approving}
            online={online || mode === 'mock'}
            onDisastersChange={setDisasters}
            onSimulate={simulate}
            onResume={() => void runner.current!.resume()}
          />
          <div className="bottom-grid">
            <section className="panel edge-panel">
              <Heading
                title={`Edge node · ${zone?.name ?? 'Select a zone'}`}
                aside={zone?.connectivity ?? ''}
              />
              <div className="tabs" aria-label="Edge node views">
                {['Field reports', 'Local resources', 'Sync queue'].map((t) => (
                  <button aria-pressed={edgeTab === t} key={t} onClick={() => setEdgeTab(t)}>
                    {t}
                    {t === 'Sync queue' ? ` (${queue.length})` : ''}
                  </button>
                ))}
              </div>
              {edgeTab === 'Field reports' ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(
                      zone?.connectivity === 'offline' || !online
                        ? 'Offline report queued'
                        : 'Field report submission',
                      submitReport
                    );
                  }}
                >
                  <label htmlFor="report">
                    Report an incident <span className="muted">· {zone?.name}</span>
                  </label>
                  <textarea
                    id="report"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    maxLength={4000}
                    required
                    rows={3}
                  />
                  <div className="form-actions">
                    <small>
                      {body.length}/4000 ·{' '}
                      {zone?.connectivity === 'offline' || !online
                        ? 'Stored on this device until sync'
                        : zone?.connectivity === 'degraded'
                          ? 'Degraded connection · state may be stale'
                          : 'Sent to command center'}
                    </small>
                    <button
                      className="blue-button"
                      disabled={!!busy || !body.trim() || !queueReady}
                    >
                      {zone?.connectivity === 'offline' || !online
                        ? 'Queue report'
                        : 'Submit report'}
                    </button>
                  </div>
                  <div className="edge-info">
                    <div>
                      <strong>Local continuity</strong>
                      <p>Reports stay on this device across refreshes. Reconnect to synchronize.</p>
                    </div>
                    <div>
                      <strong>Commander review</strong>
                      <p>Field details remain unverified. No automatic dispatch.</p>
                    </div>
                  </div>
                </form>
              ) : edgeTab === 'Sync queue' ? (
                <div className="queue-list">
                  {queue.length ? (
                    queue.map((r) => (
                      <article key={r.clientReportId}>
                        <strong>
                          {scenario.zones.find((z) => z.id === r.zoneId)?.name} · {r.syncState}
                        </strong>
                        <p>{r.body}</p>
                        {r.rejectionReason && <p className="red">{r.rejectionReason}</p>}
                        <small>{r.clientReportId.slice(0, 8)} · retained on device</small>
                      </article>
                    ))
                  ) : (
                    <p className="empty">
                      No queued reports. All acknowledged reports have left the device queue.
                    </p>
                  )}
                  <button
                    disabled={!!busy || !queue.length || !online}
                    onClick={() => void run('Reconnect and sync', sync)}
                  >
                    Synchronize selected zone
                  </button>
                </div>
              ) : (
                <div className="local-resources">
                  {scenario.resources
                    .filter((r) => zone?.facilityIds.includes(r.homeFacilityId))
                    .map((r) => (
                      <div className="unit" key={r.id}>
                        <strong>{r.callsign}</strong>
                        <span>{r.status.replaceAll('_', ' ')}</span>
                      </div>
                    ))}
                  <small>
                    Last known state · {lastSync}
                    {zone?.connectivity !== 'online' ? ' · STALE' : ''}
                  </small>
                </div>
              )}
            </section>
            <section className="panel simulation-panel">
              <Heading title="Simulation controller" aside="DETERMINISTIC" />
              <p>Network, report and reset controls · TypeScript engine.</p>
              <div className="simulation-buttons">
                <button
                  className="bridge-control"
                  disabled={!!busy || !bridge || bridge.status === 'closed'}
                  onClick={() =>
                    bridge &&
                    act(
                      'Bridge closure',
                      makeCommand('route.close_bridge', { bridgeId: bridge.id, closed: true })
                    )
                  }
                >
                  <b>1</b>
                  <span>
                    {bridge?.status === 'closed' ? 'Bridge Closed' : 'Close a Bridge'}
                    <small>{bridge?.name ?? 'No bridge configured'}</small>
                  </span>
                </button>
                <button
                  disabled={!!busy || !zone || zone.connectivity === 'offline'}
                  onClick={() =>
                    zone &&
                    act(
                      'Zone disconnect',
                      makeCommand('zone.set_connectivity', {
                        zoneId: zone.id,
                        connectivity: 'offline'
                      })
                    )
                  }
                >
                  <b>2</b>
                  <span>
                    Disconnect Zone<small>{zone?.name} · simulate network failure</small>
                  </span>
                </button>
                <button
                  className="report-control"
                  disabled={!!busy}
                  onClick={() => {
                    setBody(initialReport);
                    setEdgeTab('Field reports');
                    requestAnimationFrame(() => document.getElementById('report')?.focus());
                  }}
                >
                  <b>3</b>
                  <span>
                    Add Offline Report<small>Edit and submit in the edge panel</small>
                  </span>
                </button>
                <button
                  className="sync-control"
                  disabled={!!busy || !online}
                  onClick={() => void run('Reconnect and sync', sync)}
                >
                  <b>4</b>
                  <span>
                    Reconnect Network<small>Synchronize selected zone reports</small>
                  </span>
                </button>
                <button disabled={!!busy} onClick={() => setResetOpen(true)}>
                  <b>R</b>
                  <span>
                    Reset Simulation<small>Restore the seeded scenario</small>
                  </span>
                </button>
              </div>
              <div className="action-status" aria-live="polite">
                {busy ? `${busy}…` : notice || 'Ready · configure the synthetic exercise above'}
              </div>
            </section>
            <section className="panel logs-panel" id="communications">
              <Heading
                title="Communications & logs"
                aside={`${scenario.events.length} ENGINE EVENTS`}
              />
              <div className="tabs" aria-label="Event filters">
                {['Global log', 'Selected zone', 'System'].map((t) => (
                  <button key={t} aria-pressed={logTab === t} onClick={() => setLogTab(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <div className="timeline">
                {deliberation.session && submittedDisasters.length > 0 && (
                  <div className="log-exercise-context" aria-label="Current exercise disasters">
                    {submittedDisasters.map((disaster, index) => (
                      <DisasterBadge
                        disaster={disaster}
                        zones={scenario.zones}
                        key={`${disaster.kind}-${disaster.zoneId}-${index}`}
                      />
                    ))}
                  </div>
                )}
                {[...scenario.events]
                  .reverse()
                  .filter(
                    (e) =>
                      logTab === 'Global log' ||
                      (logTab === 'Selected zone'
                        ? e.entityIds.some(
                            (id) =>
                              id === zone?.id ||
                              zone?.incidentIds.includes(id) ||
                              zone?.facilityIds.includes(id)
                          )
                        : !['incident_reported', 'report_applied'].includes(e.type))
                  )
                  .map((e) => (
                    <article key={e.id}>
                      <time>{clock(e.occurredAt)}</time>
                      <p>{humanizeZoneIds(e.message, scenario.zones)}</p>
                    </article>
                  ))}
                <small>End of event history · synthetic exercise</small>
              </div>
            </section>
          </div>
          <footer>
            <span>RescueMesh / Pittsburgh response exercise</span>
            <span>
              {mode === 'mock'
                ? 'LOCAL MOCK · no backend writes'
                : 'API MODE · server acknowledgements required'}
            </span>
          </footer>
        </>
      )}
      {resetOpen && (
        <div className="modal-backdrop">
          <section
            className="panel modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-title"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setResetOpen(false);
              if (e.key === 'Tab') {
                const buttons = e.currentTarget.querySelectorAll('button');
                const first = buttons[0];
                const last = buttons[buttons.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <h2 id="reset-title">Reset this exercise?</h2>
            <p>
              Return the exercise to its original starting state? This clears the current disasters,
              deliberation, plan and unsynchronized local reports.
            </p>
            {queue.length > 0 && (
              <p className="muted">
                {queue.length} locally queued report{queue.length === 1 ? '' : 's'} will be
                discarded.
              </p>
            )}
            <div>
              <button autoFocus onClick={() => setResetOpen(false)}>
                Keep scenario
              </button>
              <button
                className="danger"
                onClick={() => {
                  setResetOpen(false);
                  void run('Scenario reset', async () => {
                    runner.current!.reset();
                    setApprovals({});
                    await send(makeCommand('scenario.reset', {}));
                    saveQueue([]);
                    setDisasters(defaultExercise());
                    setSubmittedDisasters([]);
                    setSelected('');
                    setBody(initialReport);
                  });
                }}
              >
                Reset scenario
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
function Heading({ title, aside }: { title: string; aside: string }) {
  return (
    <header className="panel-heading">
      <h2>{title}</h2>
      <span>{aside}</span>
    </header>
  );
}
function Metric({ value, label, color }: { value: ReactNode; label: string; color: string }) {
  return (
    <div className={`metric ${color}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function Forecast({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
