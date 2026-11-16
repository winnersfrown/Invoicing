import type { Db } from '../db/index';

export type Actor = { type: 'user' | 'agent' | 'system'; id: string | null };
export const SYSTEM: Actor = { type: 'system', id: null };

/** Appends one audit_events row. Call it in the same transaction as the change it records. */
export async function audit(db: Db, e: {
  orgId: string; actor: Actor; event: string; targetType: string; targetId: string; previous?: unknown; next?: unknown;
}): Promise<void> {
  await db.query(
    `insert into audit_events (organization_id, actor_type, actor_id, event_type, target_type, target_id, previous_state, new_state)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [e.orgId, e.actor.type, e.actor.id, e.event, e.targetType, e.targetId,
      e.previous === undefined ? null : JSON.stringify(e.previous), e.next === undefined ? null : JSON.stringify(e.next)]);
}
