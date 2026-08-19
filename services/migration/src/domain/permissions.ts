/**
 * Migration permissions (Scope §48) and the audit action vocabulary (§49).
 */

export const PERMISSIONS = [
  'migration.view',
  'migration.create',
  'migration.configure',
  'migration.start',
  'migration.pause',
  'migration.cancel',
  'migration.retry',
  'migration.admin',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export class PermissionDeniedError extends Error {
  readonly required: Permission;

  constructor(required: Permission) {
    super(`Missing required permission: ${required}`);
    this.name = 'PermissionDeniedError';
    this.required = required;
  }
}

export interface Principal {
  readonly userId: string;
  /**
   * Server-resolved tenant. Scope §47 / Guide §4.1: this comes from the
   * authenticated session, never from a request body or query parameter.
   */
  readonly tenantId: string;
  readonly permissions: readonly Permission[];
  readonly isStaff: boolean;
}

export function has(principal: Principal, permission: Permission): boolean {
  // migration.admin is a superset: internal staff troubleshooting (Scope §41)
  // must not require enumerating every individual grant.
  return principal.permissions.includes(permission) || principal.permissions.includes('migration.admin');
}

export function require(principal: Principal, permission: Permission): void {
  if (!has(principal, permission)) throw new PermissionDeniedError(permission);
}

/** Audit action vocabulary (Scope §49). */
export const AUDIT_ACTIONS = [
  'migration.created',
  'migration.source_connected',
  'migration.connection_tested',
  'migration.discovery_started',
  'migration.discovery_completed',
  'migration.mappings_changed',
  'migration.started',
  'migration.paused',
  'migration.resumed',
  'migration.cancelled',
  'migration.retried',
  'migration.validated',
  'migration.completed',
  'migration.accepted',
  'migration.cutover_completed',
  'migration.credential_rotated',
  'migration.raw_payload_purged',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
