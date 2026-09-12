import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  pittsburghFloodScenario,
  type AgentRecommendation,
  type HealthResponse,
  type IncidentDraft,
  type ParseReportResponse,
  type ReasoningSource,
  type RecommendationsResponse,
  type Scenario,
  type Severity
} from '@rescuemesh/shared';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const severityOrder: Record<Severity, number> = { critical: 0, high: 1, moderate: 2, low: 3 };
const agentNames = {
  incident_commander: 'Incident Commander',
  medical_chief: 'Medical Chief',
  police_chief: 'Police Chief',
  rescue_chief: 'Rescue Chief',
  logistics_chief: 'Logistics Chief'
};

const presetReports = [
  'Parkway East inbound near Squirrel Hill tunnel — water over both lanes, a sedan is submerged to the windows and two people are on the roof.',
  'South Side Works parking deck, ground level flooding fast. No injuries seen, about forty cars stranded and the ramp is blocked.'
];

/** Short label for the model that produced a result, or the seeded fixture. */
const sourceLabel = (source: ReasoningSource | undefined): string => {
  if (!source) return 'seeded';
  if (source.provider === 'ifm') return source.model.split('/').at(-1) ?? source.model;
  return source.degraded ? 'mock fallback' : 'mock';
};

interface RecommendationCard {
  recommendation: AgentRecommendation;
  source?: ReasoningSource;
}

export function App() {
  const [scenario, setScenario] = useState<Scenario>(pittsburghFloodScenario);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'demo'>('connecting');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [cards, setCards] = useState<RecommendationCard[]>(() =>
    pittsburghFloodScenario.recommendations.map((recommendation) => ({ recommendation }))
  );
  const [chiefsBusy, setChiefsBusy] = useState(false);
  const [chiefsError, setChiefsError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/api/scenario`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Scenario request failed');
        return response.json() as Promise<Scenario>;
      })
      .then((data) => {
        setScenario(data);
        setCards(data.recommendations.map((recommendation) => ({ recommendation })));
        setConnection('live');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setConnection('demo');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiUrl}/health`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<HealthResponse>) : null))
      .then((data) => {
        if (data) setHealth(data);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const runChiefs = useCallback(() => {
    setChiefsBusy(true);
    setChiefsError(null);
    fetch(`${apiUrl}/api/recommendations`)
      .then((response) => {
        if (!response.ok) throw new Error(`API returned ${response.status}`);
        return response.json() as Promise<RecommendationsResponse>;
      })
      .then((data) => setCards(data.items))
      .catch((error: unknown) => {
        setChiefsError(error instanceof Error ? error.message : 'Request failed');
      })
      .finally(() => setChiefsBusy(false));
  }, []);

  const incidents = useMemo(
    () =>
      [...scenario.incidents].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]),
    [scenario]
  );
  const available = scenario.resources.filter((resource) => resource.status === 'available').length;
  const reasoningBadge = health
    ? health.reasoning.configured
      ? `${health.reasoning.model.split('/').at(-1)} live`
      : 'Deterministic mock'
    : '5 roles online';

  return (
    <main>
      <header className="topbar">
        <div className="brand-mark">RM</div>
        <div>
          <p className="eyebrow">Unified response network</p>
          <h1>
            RescueMesh <span>/ Pittsburgh</span>
          </h1>
        </div>
        <div className="scenario-clock">
          <span className={`pulse ${connection}`} />
          <div>
            <strong>
              {connection === 'live'
                ? 'API connected'
                : connection === 'demo'
                  ? 'Local demo data'
                  : 'Connecting'}
            </strong>
            <small>Simulated · 18:40 EDT</small>
          </div>
        </div>
      </header>

      <section className="summary-strip" aria-label="Scenario summary">
        <Summary
          label="Active incidents"
          value={String(incidents.length).padStart(2, '0')}
          accent="alert"
        />
        <Summary
          label="People at risk"
          value={String(incidents.reduce((sum, incident) => sum + incident.peopleAtRisk, 0))}
          accent="warning"
        />
        <Summary
          label="Units available"
          value={`${available}/${scenario.resources.length}`}
          accent="safe"
        />
        <Summary
          label="Road restrictions"
          value={String(scenario.routes.filter((route) => route.status !== 'open').length).padStart(
            2,
            '0'
          )}
          accent="neutral"
        />
      </section>

      <div className="dashboard-grid">
        <section className="panel incidents-panel">
          <PanelHeader kicker="01 / Triage" title="Active incidents" badge="Priority queue" />
          <div className="incident-list">
            {incidents.map((incident, index) => (
              <article className="incident" key={incident.id}>
                <div className={`incident-index ${incident.severity}`}>
                  {String(index + 1).padStart(2, '0')}
                </div>
                <div className="incident-body">
                  <div className="incident-title-row">
                    <h3>{incident.title}</h3>
                    <span className={`severity ${incident.severity}`}>{incident.severity}</span>
                  </div>
                  <p>{incident.address}</p>
                  <div className="incident-meta">
                    <span>{incident.peopleAtRisk} people</span>
                    <span>{incident.requiredCapabilities.join(' · ')}</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel map-panel">
          <PanelHeader
            kicker="02 / Operating picture"
            title="Pittsburgh flood map"
            badge="Synthetic routes"
          />
          <div
            className="map-canvas"
            role="img"
            aria-label="Stylized map showing incidents and response facilities"
          >
            <div className="river river-a" />
            <div className="river river-b" />
            <div className="road road-a" />
            <div className="road road-b" />
            <div className="road road-c" />
            <span className="district downtown">DOWNTOWN</span>
            <span className="district oakland">OAKLAND</span>
            <span className="district south">SOUTH SIDE</span>
            {scenario.facilities.slice(0, 7).map((facility, index) => (
              <span key={facility.id} className={`marker facility m${index}`} title={facility.name}>
                +
              </span>
            ))}
            {incidents.map((incident, index) => (
              <span
                key={incident.id}
                className={`marker incident-marker i${index}`}
                title={incident.title}
              >
                <b>{index + 1}</b>
              </span>
            ))}
            <div className="map-legend">
              <span>
                <i className="legend-facility">+</i> Facility
              </span>
              <span>
                <i className="legend-incident" /> Incident
              </span>
              <span>
                <i className="legend-route" /> Restricted route
              </span>
            </div>
          </div>
        </section>

        <section className="panel resources-panel">
          <PanelHeader
            kicker="03 / Deployment"
            title="Response units"
            badge={`${available} available`}
          />
          <div className="resource-list">
            {scenario.resources.map((resource) => (
              <div className="resource" key={resource.id}>
                <span className={`resource-dot ${resource.status}`} />
                <div>
                  <strong>{resource.callsign}</strong>
                  <small>{resource.kind.replaceAll('_', ' ')}</small>
                </div>
                <span className="resource-status">{resource.status.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel agents-panel">
          <header className="panel-header">
            <div>
              <p className="eyebrow">04 / Decision layer</p>
              <h2>AI chief recommendations</h2>
            </div>
            <div className="header-actions">
              <span className="badge">{reasoningBadge}</span>
              <button type="button" onClick={runChiefs} disabled={chiefsBusy}>
                {chiefsBusy ? 'Consulting…' : 'Ask the chiefs'}
              </button>
            </div>
          </header>
          {chiefsError ? <p className="panel-error">{chiefsError}</p> : null}
          <div className="recommendations">
            {cards.map(({ recommendation, source }) => (
              <article className="recommendation" key={recommendation.id}>
                <div className="agent-avatar">
                  {agentNames[recommendation.agent]
                    .split(' ')
                    .map((word) => word[0])
                    .join('')
                    .slice(0, 2)}
                </div>
                <div>
                  <p className="agent-name">
                    {agentNames[recommendation.agent]} ·{' '}
                    {Math.round(recommendation.confidence * 100)}% ·{' '}
                    <em title={source?.warning ?? undefined}>{sourceLabel(source)}</em>
                  </p>
                  <strong>{recommendation.summary}</strong>
                  <p>{recommendation.action}</p>
                </div>
                <span className={`rec-state ${recommendation.status}`}>
                  {recommendation.status}
                </span>
              </article>
            ))}
          </div>
        </section>

        <section className="panel timeline-panel">
          <PanelHeader
            kicker="05 / Live log"
            title="World-state events"
            badge="Deterministic feed"
          />
          <div className="timeline">
            {[...scenario.events].reverse().map((event) => (
              <div className="event" key={event.id}>
                <time>
                  {new Date(event.occurredAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </time>
                <span />
                <p>{event.message}</p>
              </div>
            ))}
          </div>
        </section>

        <ReportConsole />
      </div>

      <footer>
        <span>
          EXERCISE ONLY — Synthetic incident, capacities, travel times, and recommendations
        </span>
        <span>RescueMesh v0.1</span>
      </footer>
    </main>
  );
}

function ReportConsole() {
  const [report, setReport] = useState(presetReports[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ incident: IncidentDraft; source: ReasoningSource } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!report.trim() || busy) return;
    setBusy(true);
    setError(null);
    fetch(`${apiUrl}/api/reports/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report })
    })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) {
          const message =
            typeof body === 'object' && body !== null && 'error' in body
              ? String((body as { error: unknown }).error)
              : `API returned ${response.status}`;
          throw new Error(message);
        }
        return body as ParseReportResponse;
      })
      .then(setDraft)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Request failed');
        setDraft(null);
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="panel report-panel">
      <PanelHeader
        kicker="06 / Intake"
        title="Field report → structured incident"
        badge="Human review required"
      />
      <div className="report-body">
        <div className="report-input">
          <label className="eyebrow" htmlFor="field-report">
            Radio or phone report
          </label>
          <textarea
            id="field-report"
            value={report}
            rows={5}
            onChange={(event) => setReport(event.target.value)}
            placeholder="Describe what the caller reported…"
          />
          <div className="report-actions">
            {presetReports.map((preset, index) => (
              <button
                type="button"
                className="ghost"
                key={preset}
                onClick={() => setReport(preset)}
              >
                Preset {index + 1}
              </button>
            ))}
            <button type="button" onClick={submit} disabled={busy || !report.trim()}>
              {busy ? 'Parsing…' : 'Parse report'}
            </button>
          </div>
        </div>
        <div className="report-output" aria-live="polite">
          {error ? <p className="panel-error">{error}</p> : null}
          {!error && !draft ? (
            <p className="report-hint">
              Parses one report into a reviewable incident draft. Nothing is dispatched — a
              commander approves before it becomes a world-state event.
            </p>
          ) : null}
          {draft ? (
            <article className="draft">
              <div className="draft-head">
                <span className={`severity ${draft.incident.severity}`}>
                  {draft.incident.severity}
                </span>
                <span className="draft-source" title={draft.source.warning ?? undefined}>
                  {draft.source.provider === 'ifm' ? 'IFM' : 'Mock'} · {sourceLabel(draft.source)}
                </span>
              </div>
              <strong>{draft.incident.title}</strong>
              <p>{draft.incident.description}</p>
              {draft.source.degraded ? (
                <p className="draft-warning">
                  IFM call failed, so the deterministic mock answered: {draft.source.warning}
                </p>
              ) : null}
            </article>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PanelHeader({ kicker, title, badge }: { kicker: string; title: string; badge: string }) {
  return (
    <header className="panel-header">
      <div>
        <p className="eyebrow">{kicker}</p>
        <h2>{title}</h2>
      </div>
      <span className="badge">{badge}</span>
    </header>
  );
}

function Summary({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className={`summary ${accent}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
