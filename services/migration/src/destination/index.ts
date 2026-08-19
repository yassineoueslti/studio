import { config } from '../config.js';
import { HttpDestination } from './http.js';
import { SandboxDestination } from './sandbox.js';
import type { DestinationClient } from './types.js';

export * from './types.js';
export { SandboxDestination } from './sandbox.js';
export { HttpDestination } from './http.js';

let cached: DestinationClient | null = null;

/**
 * Resolve the configured destination driver. Guide §1: the engine talks to one
 * interface; whether that is the sandbox or the real BuilderLync API is a
 * deployment decision, not a code path the pipeline knows about.
 */
export function getDestination(): DestinationClient {
  if (!cached) {
    cached = config().DESTINATION_DRIVER === 'http' ? new HttpDestination() : new SandboxDestination();
  }
  return cached;
}

export function setDestination(client: DestinationClient | null): void {
  cached = client;
}
