import type { Scenario } from './types.js';

export const pittsburghFloodScenario: Scenario = {
  id: 'pgh-flash-flood-001',
  name: 'Monongahela Flash Flood — 18:40',
  city: 'Pittsburgh',
  simulatedTime: '2026-07-18T18:40:00-04:00',
  status: 'active',
  facilities: [
    {
      id: 'h-mercy',
      name: 'UPMC Mercy',
      kind: 'hospital',
      location: { lat: 40.4361, lng: -79.9858 },
      syntheticCapacity: 24,
      currentLoad: 17,
      status: 'operational'
    },
    {
      id: 'h-presby',
      name: 'UPMC Presbyterian',
      kind: 'hospital',
      location: { lat: 40.4415, lng: -79.9609 },
      syntheticCapacity: 32,
      currentLoad: 25,
      status: 'operational'
    },
    {
      id: 'h-agh',
      name: 'Allegheny General Hospital',
      kind: 'hospital',
      location: { lat: 40.457, lng: -80.003 },
      syntheticCapacity: 28,
      currentLoad: 12,
      status: 'operational'
    },
    {
      id: 'f-07',
      name: 'Fire House 7 — South Side',
      kind: 'fire_house',
      location: { lat: 40.4282, lng: -79.9814 },
      syntheticCapacity: 4,
      currentLoad: 3,
      status: 'limited'
    },
    {
      id: 'f-03',
      name: 'Fire House 3 — Strip District',
      kind: 'fire_house',
      location: { lat: 40.4535, lng: -79.982 },
      syntheticCapacity: 4,
      currentLoad: 2,
      status: 'operational'
    },
    {
      id: 'f-19',
      name: 'Fire House 19 — Swissvale',
      kind: 'fire_house',
      location: { lat: 40.4208, lng: -79.887 },
      syntheticCapacity: 3,
      currentLoad: 1,
      status: 'operational'
    },
    {
      id: 'p-zone1',
      name: 'Police Zone 1 Hub',
      kind: 'police_hub',
      location: { lat: 40.4577, lng: -79.9785 },
      syntheticCapacity: 8,
      currentLoad: 5,
      status: 'operational'
    },
    {
      id: 'p-zone4',
      name: 'Police Zone 4 Hub',
      kind: 'police_hub',
      location: { lat: 40.4312, lng: -79.9235 },
      syntheticCapacity: 8,
      currentLoad: 6,
      status: 'operational'
    },
    {
      id: 'r-river',
      name: 'River Rescue — North Shore',
      kind: 'rescue_center',
      location: { lat: 40.447, lng: -80.011 },
      syntheticCapacity: 5,
      currentLoad: 3,
      status: 'operational'
    },
    {
      id: 'r-east',
      name: 'East Response Staging',
      kind: 'rescue_center',
      location: { lat: 40.442, lng: -79.912 },
      syntheticCapacity: 5,
      currentLoad: 2,
      status: 'operational'
    }
  ],
  resources: [
    {
      id: 'amb-12',
      callsign: 'MED-12',
      kind: 'ambulance',
      homeFacilityId: 'h-mercy',
      status: 'en_route',
      crew: 2,
      capabilities: ['advanced-life-support']
    },
    {
      id: 'amb-21',
      callsign: 'MED-21',
      kind: 'ambulance',
      homeFacilityId: 'h-presby',
      status: 'available',
      crew: 2,
      capabilities: ['advanced-life-support']
    },
    {
      id: 'eng-07',
      callsign: 'ENGINE-07',
      kind: 'fire_engine',
      homeFacilityId: 'f-07',
      status: 'assigned',
      crew: 4,
      capabilities: ['high-water-response', 'fire-suppression']
    },
    {
      id: 'eng-03',
      callsign: 'ENGINE-03',
      kind: 'fire_engine',
      homeFacilityId: 'f-03',
      status: 'available',
      crew: 4,
      capabilities: ['fire-suppression']
    },
    {
      id: 'pol-14',
      callsign: 'ZONE1-14',
      kind: 'police_unit',
      homeFacilityId: 'p-zone1',
      status: 'assigned',
      crew: 2,
      capabilities: ['traffic-control', 'evacuation']
    },
    {
      id: 'pol-42',
      callsign: 'ZONE4-42',
      kind: 'police_unit',
      homeFacilityId: 'p-zone4',
      status: 'available',
      crew: 2,
      capabilities: ['traffic-control', 'evacuation']
    },
    {
      id: 'boat-2',
      callsign: 'RIVER-2',
      kind: 'rescue_boat',
      homeFacilityId: 'r-river',
      status: 'en_route',
      crew: 4,
      capabilities: ['swift-water-rescue']
    },
    {
      id: 'boat-5',
      callsign: 'EAST-5',
      kind: 'rescue_boat',
      homeFacilityId: 'r-east',
      status: 'available',
      crew: 3,
      capabilities: ['swift-water-rescue']
    },
    {
      id: 'log-1',
      callsign: 'SUPPLY-1',
      kind: 'supply_truck',
      homeFacilityId: 'r-east',
      status: 'available',
      crew: 2,
      capabilities: ['barriers', 'medical-supplies']
    }
  ],
  incidents: [
    {
      id: 'inc-parkway',
      title: 'Parkway East underpass flooding',
      description: 'Two vehicles trapped in rapidly rising water near the Bates Street approach.',
      severity: 'critical',
      location: { lat: 40.4304, lng: -79.9579 },
      address: 'Bates St & Second Ave',
      reportedAt: '2026-07-18T18:31:00-04:00',
      status: 'active',
      peopleAtRisk: 6,
      requiredCapabilities: ['swift-water-rescue', 'traffic-control']
    },
    {
      id: 'inc-southside',
      title: 'South Side basement evacuations',
      description: 'Multiple calls from a low-lying residential block; utilities not yet isolated.',
      severity: 'high',
      location: { lat: 40.4247, lng: -79.9768 },
      address: 'S 18th St & Sarah St',
      reportedAt: '2026-07-18T18:34:00-04:00',
      status: 'active',
      peopleAtRisk: 14,
      requiredCapabilities: ['evacuation', 'advanced-life-support']
    },
    {
      id: 'inc-trail',
      title: 'Eliza Furnace Trail washout',
      description:
        'Cyclists sheltering above a washed-out segment; access from the west is blocked.',
      severity: 'moderate',
      location: { lat: 40.4315, lng: -79.9388 },
      address: 'Three Rivers Heritage Trail',
      reportedAt: '2026-07-18T18:37:00-04:00',
      status: 'active',
      peopleAtRisk: 4,
      requiredCapabilities: ['evacuation']
    }
  ],
  routes: [
    {
      id: 'route-river-parkway',
      fromId: 'r-river',
      toId: 'inc-parkway',
      distanceKm: 6.8,
      travelMinutes: 14,
      status: 'slow',
      synthetic: true
    },
    {
      id: 'route-east-parkway',
      fromId: 'r-east',
      toId: 'inc-parkway',
      distanceKm: 5.1,
      travelMinutes: 9,
      status: 'open',
      synthetic: true
    },
    {
      id: 'route-mercy-south',
      fromId: 'h-mercy',
      toId: 'inc-southside',
      distanceKm: 2.7,
      travelMinutes: 7,
      status: 'open',
      synthetic: true
    },
    {
      id: 'route-zone4-trail',
      fromId: 'p-zone4',
      toId: 'inc-trail',
      distanceKm: 2.4,
      travelMinutes: 6,
      status: 'open',
      synthetic: true
    },
    {
      id: 'route-west-trail',
      fromId: 'p-zone1',
      toId: 'inc-trail',
      distanceKm: 7.2,
      travelMinutes: 22,
      status: 'closed',
      synthetic: true
    }
  ],
  assignments: [
    {
      id: 'as-001',
      incidentId: 'inc-parkway',
      resourceIds: ['boat-2', 'pol-14'],
      destinationFacilityId: 'h-agh',
      priority: 1,
      status: 'dispatched',
      rationale:
        'Closest dispatched swift-water team paired with traffic control; AGH has the highest modeled spare capacity.'
    },
    {
      id: 'as-002',
      incidentId: 'inc-southside',
      resourceIds: ['eng-07', 'amb-12'],
      destinationFacilityId: 'h-mercy',
      priority: 2,
      status: 'approved',
      rationale: 'Local engine supports evacuation while the nearest ALS unit stages uphill.'
    }
  ],
  recommendations: [
    {
      id: 'rec-ic-1',
      agent: 'incident_commander',
      summary: 'Protect the Parkway rescue corridor',
      confidence: 0.91,
      action: 'Hold the Second Avenue eastbound lane for incoming rescue units.',
      relatedIncidentId: 'inc-parkway',
      createdAt: '2026-07-18T18:39:10-04:00',
      status: 'pending'
    },
    {
      id: 'rec-med-1',
      agent: 'medical_chief',
      summary: 'Route new critical patients to AGH',
      confidence: 0.86,
      action: 'Preserve Mercy capacity for South Side walk-ins.',
      relatedIncidentId: 'inc-southside',
      createdAt: '2026-07-18T18:39:20-04:00',
      status: 'accepted'
    },
    {
      id: 'rec-pol-1',
      agent: 'police_chief',
      summary: 'Close Bates Street low point',
      confidence: 0.94,
      action: 'Move ZONE4-42 to the upstream intersection.',
      relatedIncidentId: 'inc-parkway',
      createdAt: '2026-07-18T18:39:28-04:00',
      status: 'pending'
    },
    {
      id: 'rec-rescue-1',
      agent: 'rescue_chief',
      summary: 'Stage second boat east',
      confidence: 0.79,
      action: 'Keep EAST-5 available for escalation near the trail.',
      relatedIncidentId: 'inc-trail',
      createdAt: '2026-07-18T18:39:35-04:00',
      status: 'pending'
    },
    {
      id: 'rec-log-1',
      agent: 'logistics_chief',
      summary: 'Pre-position barriers',
      confidence: 0.83,
      action: 'Send SUPPLY-1 to the Birmingham Bridge approach.',
      createdAt: '2026-07-18T18:39:42-04:00',
      status: 'pending'
    }
  ],
  events: [
    {
      id: 'evt-1',
      occurredAt: '2026-07-18T18:31:00-04:00',
      type: 'incident_reported',
      message: 'Vehicle entrapment reported at Bates Street underpass.',
      entityIds: ['inc-parkway']
    },
    {
      id: 'evt-2',
      occurredAt: '2026-07-18T18:33:00-04:00',
      type: 'road_changed',
      message: 'West trail access marked closed by simulator.',
      entityIds: ['route-west-trail']
    },
    {
      id: 'evt-3',
      occurredAt: '2026-07-18T18:36:00-04:00',
      type: 'resource_dispatched',
      message: 'RIVER-2 and ZONE1-14 dispatched.',
      entityIds: ['boat-2', 'pol-14', 'inc-parkway']
    },
    {
      id: 'evt-4',
      occurredAt: '2026-07-18T18:38:00-04:00',
      type: 'facility_updated',
      message: 'Mercy modeled load increased to 17 of 24.',
      entityIds: ['h-mercy']
    }
  ]
};
