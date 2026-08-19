import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';

/**
 * Webhook event inbox (Scope §52, Guide §18.3).
 *
 * "Never send external webhooks directly into business logic."
 * Vendor -> endpoint -> immutable inbox -> deduplication -> queue -> processor.
 *
 * The endpoint's only job is to durably record the event and return quickly.
 * Deduplication happens at the storage layer via two partial unique indexes:
 * on vendor event id where the vendor supplies one, and on a payload hash where
 * it does not -- which is the ProLine case, whose documentation states delivery
 * and retries are not guaranteed (Guide §10.5).
 */

export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post('/webhooks/:vendor', async (request, reply) => {
    const { vendor } = z.object({ vendor: z.string().min(1).max(64) }).parse(request.params);
    const payload = (request.body ?? {}) as Record<string, unknown>;

    // Vendors disagree on where the event id lives; check the common shapes
    // before falling back to content hashing.
    const vendorEventId =
      firstString(payload['event_id'], payload['id'], payload['eventId'], request.headers['x-event-id']);

    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const eventType = firstString(payload['type'], payload['event'], payload['event_type']);

    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO migration_webhook_inbox (vendor, vendor_event_id, event_type, payload, payload_hash, status)
       VALUES ($1,$2,$3,$4,$5,'RECEIVED')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [vendor, vendorEventId, eventType, JSON.stringify(payload), payloadHash],
    );

    // A duplicate is a success from the vendor's perspective: returning an
    // error would make a well-behaved vendor retry an event we already hold.
    if (rows.length === 0) {
      return reply.code(202).send({ received: true, duplicate: true });
    }

    return reply.code(202).send({ received: true, duplicate: false, event_id: rows[0]?.id });
  });

  /** Inbox inspection, for delta-sync troubleshooting. */
  app.get('/webhooks/:vendor/inbox', async (request) => {
    const { vendor } = z.object({ vendor: z.string() }).parse(request.params);
    const { rows } = await getPool().query(
      `SELECT id, vendor_event_id, event_type, status, received_at, processed_at, attempt_count, error_message
         FROM migration_webhook_inbox WHERE vendor = $1 ORDER BY received_at DESC LIMIT 200`,
      [vendor],
    );
    return { events: rows };
  });
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
