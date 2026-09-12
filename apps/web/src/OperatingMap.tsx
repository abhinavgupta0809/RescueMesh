import { useState } from 'react';
import type { Coordinate } from '@rescuemesh/shared';
import type { Scenario } from './contract';

// Deliberately schematic, interactive geography; no provider, tile requests or live routes.
const point = (location: Coordinate) => ({
  x: 65 + ((location.lng + 80.025) / 0.155) * 590,
  y: 85 + ((40.468 - location.lat) / 0.06) * 455
});
const labels = { hospital: 'H', fire_house: 'F', police_hub: 'P', rescue_center: 'R' };
export function OperatingMap({
  scenario,
  selected,
  onSelect
}: {
  scenario: Scenario;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [layers, setLayers] = useState({ facilities: true, incidents: true, routes: true });
  const entities = [...scenario.facilities, ...scenario.incidents];
  return (
    <div className="map-canvas">
      <div className="map-layers" aria-label="Map layers">
        {Object.entries(layers).map(([name, checked]) => (
          <label key={name}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => setLayers({ ...layers, [name]: !checked })}
            />
            {name}
          </label>
        ))}
      </div>
      <svg
        viewBox="0 0 720 600"
        aria-label="Schematic Pittsburgh operating map. Use the labeled markers to inspect facilities and incidents."
      >
        <rect width="720" height="600" fill="#0b1b24" />
        <g transform={`translate(${360 * (1 - zoom)} ${300 * (1 - zoom)}) scale(${zoom})`}>
          <g stroke="#21343e" strokeWidth="1" opacity=".8">
            {Array.from({ length: 23 }, (_, i) => (
              <path
                key={`h${i}`}
                d={`M -50 ${i * 29} L 760 ${i * 29 - 200} M ${i * 37} -40 L ${i * 37 - 220} 640`}
              />
            ))}
          </g>
          <g fill="none" strokeLinecap="round">
            <path
              d="M -20 310 C 100 302 142 316 234 328 C 354 352 420 490 730 440 M 234 328 C 275 260 350 145 445 -20"
              stroke="#133f57"
              strokeWidth="34"
            />
            <path
              d="M -20 310 C 100 302 142 316 234 328 C 354 352 420 490 730 440 M 234 328 C 275 260 350 145 445 -20"
              stroke="#1e6583"
              strokeWidth="2"
            />
            <path
              d="M 40 420 L 212 298 L 344 204 L 700 130 M 130 50 L 180 220 L 275 400 L 630 540 M 10 240 L 410 360 L 680 260"
              stroke="#657261"
              strokeWidth="2"
            />
            <path
              d="M 190 55 L 242 248 L 412 375 L 660 397"
              stroke="#ad9560"
              strokeWidth="2"
              strokeDasharray="7 5"
            />
          </g>
          <g className="map-zones">
            <path
              d="M 66 128 L 212 88 L 281 193 L 214 307 L 104 284 Z"
              fill={scenario.zones[0]?.connectivity === 'offline' ? '#772e3b' : '#16654e'}
              stroke={scenario.zones[0]?.connectivity === 'offline' ? '#ff6070' : '#36c78b'}
            />
            <path
              d="M 337 174 L 427 126 L 490 251 L 423 368 L 288 295 Z"
              fill={scenario.zones[1]?.connectivity === 'offline' ? '#772e3b' : '#705729'}
              stroke={scenario.zones[1]?.connectivity === 'offline' ? '#ff6070' : '#d3ac54'}
            />
            <path
              d="M 472 298 L 645 266 L 696 390 L 614 522 L 460 463 Z"
              fill={scenario.zones[2]?.connectivity === 'offline' ? '#772e3b' : '#254b5c'}
              stroke={scenario.zones[2]?.connectivity === 'offline' ? '#ff6070' : '#4ba5d1'}
            />
          </g>
          <g className="geographic-labels">
            <text x="82" y="69">
              NORTH SHORE
            </text>
            <text x="355" y="75">
              Lawrenceville
            </text>
            <text x="505" y="189">
              Shadyside
            </text>
            <text x="135" y="478">
              Mount Washington
            </text>
            <text x="333" y="530">
              South Side
            </text>
            <text x="505" y="571">
              Monongahela River
            </text>
            <text x="225" y="350" className="city-label">
              Pittsburgh
            </text>
          </g>
          <g className="zone-labels">
            <text x="165" y="231">
              Zone A
              <tspan x="165" dy="20">
                Downtown
              </tspan>
              <tspan x="165" dy="18" className="zone-state">
                {scenario.zones[0]?.connectivity}
              </tspan>
            </text>
            <text x="387" y="263">
              Zone B
              <tspan x="387" dy="20">
                Oakland
              </tspan>
              <tspan x="387" dy="18" className="zone-state">
                {scenario.zones[1]?.connectivity}
              </tspan>
            </text>
            <text x="568" y="411">
              Zone C
              <tspan x="568" dy="20">
                East End
              </tspan>
              <tspan x="568" dy="18" className="zone-state">
                {scenario.zones[2]?.connectivity}
              </tspan>
            </text>
          </g>
          {layers.routes &&
            scenario.routes.map((route) => {
              const from = entities.find((e) => e.id === route.fromId);
              const to = entities.find((e) => e.id === route.toId);
              if (!from || !to) return null;
              const a = point(from.location);
              const b = point(to.location);
              return (
                <g key={route.id}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={route.status === 'closed' ? '#ff5965' : '#e7c877'}
                    strokeWidth="2"
                    strokeDasharray={route.status === 'closed' ? '3 5' : '7 5'}
                  >
                    <title>
                      {route.id}: {route.status} · {route.travelMinutes} synthetic minutes
                    </title>
                  </line>
                  {route.status === 'closed' && (
                    <text className="closure-label" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2}>
                      CLOSED
                    </text>
                  )}
                </g>
              );
            })}
          {layers.facilities &&
            scenario.facilities.map((f) => {
              const p = point(f.location);
              return (
                <g
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${f.name}, ${f.kind.replaceAll('_', ' ')}`}
                  aria-pressed={selected === f.id}
                  className={`map-marker ${f.kind} ${selected === f.id ? 'selected' : ''}`}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => onSelect(f.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(f.id);
                    }
                  }}
                >
                  <title>{f.name}</title>
                  <rect x="-15" y="-15" width="30" height="30" rx="5" />
                  <text textAnchor="middle" dy="5">
                    {labels[f.kind]}
                  </text>
                </g>
              );
            })}
          {layers.incidents &&
            scenario.incidents.map((incident, i) => {
              const p = point(incident.location);
              return (
                <g
                  key={incident.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Incident ${i + 1}: ${incident.title}`}
                  aria-pressed={selected === incident.id}
                  className={`map-marker incident-pin ${selected === incident.id ? 'selected' : ''}`}
                  transform={`translate(${p.x + 18} ${p.y + 15})`}
                  onClick={() => onSelect(incident.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(incident.id);
                    }
                  }}
                >
                  <title>{incident.title}</title>
                  <circle r="15" />
                  <text textAnchor="middle" dy="5">
                    {i + 1}
                  </text>
                </g>
              );
            })}
        </g>
      </svg>
      <div className="map-legend">
        <span className="red">H Hospital</span>
        <span className="amber">F Fire house</span>
        <span className="blue">P Police hub</span>
        <span className="green">R Rescue center</span>
        <span>Numbered incidents</span>
      </div>
      <div className="map-zoom">
        <button
          aria-label="Zoom in"
          disabled={zoom >= 1.6}
          onClick={() => setZoom((z) => Math.min(1.6, z + 0.2))}
        >
          +
        </button>
        <button
          aria-label="Zoom out"
          disabled={zoom <= 1}
          onClick={() => setZoom((z) => Math.max(1, z - 0.2))}
        >
          −
        </button>
        <button aria-label="Reset map zoom" onClick={() => setZoom(1)}>
          1:1
        </button>
      </div>
    </div>
  );
}
