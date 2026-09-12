import type { DisasterKind, DisasterSpecification, Incident, Zone } from '@rescuemesh/shared';

export const DISASTER_PRESENTATION: Record<
  DisasterKind,
  { label: string; glyph: string; tone: 'flood' | 'fire' | 'collision' }
> = {
  flash_flood: { label: 'Flash flood', glyph: '≋', tone: 'flood' },
  structural_fire: { label: 'Structural fire', glyph: '🔥', tone: 'fire' },
  multi_vehicle_collision: { label: 'Multi-vehicle collision', glyph: '⚠', tone: 'collision' }
};

export function DisasterIcon({ kind }: { kind: DisasterKind }) {
  const item = DISASTER_PRESENTATION[kind];
  return (
    <span className={`disaster-icon ${item.tone}`} aria-hidden="true">
      {item.glyph}
    </span>
  );
}

export function DisasterBadge({
  disaster,
  zones
}: {
  disaster: DisasterSpecification;
  zones: Zone[];
}) {
  const item = DISASTER_PRESENTATION[disaster.kind];
  const zone = zones.find((candidate) => candidate.id === disaster.zoneId);
  return (
    <span className={`disaster-badge ${item.tone}`}>
      <DisasterIcon kind={disaster.kind} />
      <span>
        {item.label} · {zone?.name ?? disaster.zoneId}
      </span>
    </span>
  );
}

export function disasterKindForIncident(incident: Incident): DisasterKind | undefined {
  if (!incident.id.startsWith('inc-exr-')) return undefined;
  if (incident.title.startsWith('Flash flooding')) return 'flash_flood';
  if (incident.title.startsWith('Structural fire')) return 'structural_fire';
  if (incident.title.startsWith('Multi-vehicle collision')) return 'multi_vehicle_collision';
  return undefined;
}

export function zoneForIncident(incidentId: string, zones: Zone[]): Zone | undefined {
  return zones.find((zone) => zone.incidentIds.includes(incidentId));
}

export function humanizeZoneIds(message: string, zones: Zone[]): string {
  return zones.reduce(
    (value, zone) => value.replaceAll(` in ${zone.id}`, ` in ${zone.name}`),
    message
  );
}
