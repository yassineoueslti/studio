import type { SourcePlatform } from '../canonical/common.js';
import { MockAdapter, type MockAdapterOptions } from './mock/index.js';
import { PLANNED_SPECS, PlannedAdapter, type PlannedAdapterSpec } from './planned.js';
import type { SourceAdapter, SourceCapabilities } from './types.js';

/**
 * Source registry (Scope §65).
 *
 * "Do not hardcode assumptions throughout workflows" -- the wizard, preflight,
 * discovery and reconciliation all ask this registry what a source supports
 * rather than embedding per-platform conditionals.
 */

const SPEC_BY_PLATFORM = new Map<SourcePlatform, PlannedAdapterSpec>(
  PLANNED_SPECS.map((spec) => [spec.platform, spec]),
);

export interface SourceDescriptor {
  platform: SourcePlatform;
  displayName: string;
  status: 'available' | 'planned';
  authKind: string;
  capabilities: SourceCapabilities;
  connectorVersion: string;
  notes: Readonly<Partial<Record<string, string>>>;
}

const DISPLAY_NAMES: Record<SourcePlatform, string> = {
  highlevel: 'GoHighLevel',
  acculynx: 'AccuLynx',
  jobnimbus: 'JobNimbus',
  proline: 'ProLine',
  roofr: 'Roofr',
  file_import: 'Other CRM / File Import',
  mock: 'Mock CRM (test source)',
};

/** Wizard step 1 (Scope §32): the source cards, with honest status. */
export function listSources(): SourceDescriptor[] {
  return PLANNED_SPECS.map((spec) => ({
    platform: spec.platform,
    displayName: DISPLAY_NAMES[spec.platform],
    status: 'planned' as const,
    authKind: spec.authKind,
    capabilities: spec.capabilities,
    connectorVersion: spec.connectorVersion,
    notes: spec.capabilities.notes,
  }));
}

export function getSpec(platform: SourcePlatform): PlannedAdapterSpec | null {
  return SPEC_BY_PLATFORM.get(platform) ?? null;
}

/**
 * Build an adapter instance. The mock adapter needs generation options, so it
 * is constructed by the caller and registered rather than resolved by name.
 */
export function createAdapter(platform: SourcePlatform, options?: MockAdapterOptions): SourceAdapter {
  if (platform === 'mock') {
    return new MockAdapter(options ?? { contacts: 100, jobs: 20 });
  }
  const spec = SPEC_BY_PLATFORM.get(platform);
  if (!spec) throw new Error(`Unknown source platform "${platform}"`);
  return new PlannedAdapter(spec);
}

export { MockAdapter, PlannedAdapter };
export type { MockAdapterOptions, PlannedAdapterSpec };
