export const STORAGE_KEY = 'kundeplan-cartoon-atlas-v2';

export const demoParts = [
  {
    id: 'plan-root',
    name: 'Customer plan root',
    owner: 'ATEA strategy office',
    residesIn: 'Portfolio vault',
    presentedIn: 'Executive steering',
    description: 'Single source for the customer plan tree.',
    sourceId: null,
    dependencies: ['roadmap-ops', 'support-playbook'],
    position: { x: 120, y: 140 },
  },
  {
    id: 'roadmap-ops',
    name: 'Delivery roadmap',
    owner: 'Service design guild',
    residesIn: 'Delivery compass',
    presentedIn: 'Quarterly review',
    description: 'Operational milestones and sequencing.',
    sourceId: 'plan-root',
    dependencies: ['platform-stack'],
    position: { x: 420, y: 100 },
  },
  {
    id: 'support-playbook',
    name: 'Support playbook',
    owner: 'Operations lead',
    residesIn: 'Operations vault',
    presentedIn: 'Runbook wall',
    description: 'How customer-facing support is executed.',
    sourceId: 'plan-root',
    dependencies: ['platform-stack', 'reporting-cockpit'],
    position: { x: 420, y: 280 },
  },
  {
    id: 'platform-stack',
    name: 'Platform stack',
    owner: 'Infrastructure steward',
    residesIn: 'Tech attic',
    presentedIn: 'Architecture review',
    description: 'Shared technical foundation.',
    sourceId: 'roadmap-ops',
    dependencies: [],
    position: { x: 720, y: 80 },
  },
  {
    id: 'reporting-cockpit',
    name: 'Reporting cockpit',
    owner: 'Analytics owner',
    residesIn: 'Insights shelf',
    presentedIn: 'Management board',
    description: 'Status and outcome visualisation.',
    sourceId: 'support-playbook',
    dependencies: ['platform-stack'],
    position: { x: 720, y: 300 },
  },
  {
    id: 'customer-communication',
    name: 'Customer communication',
    owner: 'Account director',
    residesIn: 'Go-to-market drawer',
    presentedIn: 'Customer advisory',
    description: 'Messages and touchpoints for the customer journey.',
    sourceId: 'plan-root',
    dependencies: ['reporting-cockpit'],
    position: { x: 420, y: 460 },
  },
];

export function createId(prefix = 'part') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createEmptyDraft() {
  return {
    id: createId(),
    name: '',
    owner: '',
    residesIn: '',
    presentedIn: '',
    description: '',
    sourceId: null,
    sourceAnchor: { from: 'right', to: 'left' },
    dependencies: [],
    dependencyAnchors: {},
    position: { x: 140, y: 140 },
  };
}