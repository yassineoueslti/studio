import type { FastifyReply, FastifyRequest } from 'fastify';
import { PERMISSIONS, type Permission, type Principal } from '../domain/permissions.js';

/**
 * Request authentication and tenant resolution.
 *
 * Guide §4.1 and Scope §47 are one requirement stated twice: the browser or an
 * n8n workflow must never be able to choose the destination tenant. The tenant
 * on the Principal therefore comes from the verified token, and every service
 * call is scoped by it. A tenant id appearing in a request body is ignored.
 *
 * This is a boundary adapter. In BuilderLync it is replaced by the application's
 * own session/JWT verification; the contract it must satisfy is exactly the
 * Principal type -- a user id, a server-resolved tenant, and a permission set.
 */

export interface TokenRecord {
  token: string;
  userId: string;
  tenantId: string;
  permissions: readonly Permission[];
  isStaff?: boolean;
}

export class TokenDirectory {
  private readonly byToken = new Map<string, TokenRecord>();

  register(record: TokenRecord): void {
    this.byToken.set(record.token, record);
  }

  resolve(token: string): TokenRecord | null {
    return this.byToken.get(token) ?? null;
  }

  clear(): void {
    this.byToken.clear();
  }
}

export const tokens = new TokenDirectory();

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication required.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export function principalFrom(request: FastifyRequest): Principal {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new UnauthorizedError('A bearer token is required.');
  }

  const record = tokens.resolve(header.slice('Bearer '.length).trim());
  if (!record) throw new UnauthorizedError('The supplied token is not valid.');

  return {
    userId: record.userId,
    // Server-resolved. Never read from the body, query or a custom header.
    tenantId: record.tenantId,
    permissions: record.permissions,
    isStaff: record.isStaff ?? false,
  };
}

export function requireAuth(request: FastifyRequest, reply: FastifyReply): Principal | null {
  try {
    return principalFrom(request);
  } catch (err) {
    reply.code(401).send({ error: { code: 'AUTHENTICATION_ERROR', message: (err as Error).message } });
    return null;
  }
}

/**
 * Register a fully-permissioned token and return the matching Principal.
 * For tests, local development and the acceptance demo only.
 */
export function grantAll(userId: string, tenantId: string, token: string, isStaff = false): Principal {
  tokens.register({ token, userId, tenantId, permissions: [...PERMISSIONS], isStaff });
  return { userId, tenantId, permissions: [...PERMISSIONS], isStaff };
}
