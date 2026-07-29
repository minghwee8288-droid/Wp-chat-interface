import { unwrap } from './db.js'

// Round-robin auto-assignment. Two independent rotations (sales, operations),
// each a persistent per-department cursor advanced atomically in the DB
// (wp_chat_next_rotation), so concurrent creations never grab the same agent
// and the rotation survives restarts.

export const ASSIGNABLE_DEPARTMENTS = ['sales', 'operations']

// --------------------------------------------------------------------
// Pure helpers (no I/O) — unit-tested without a database.
// --------------------------------------------------------------------

/**
 * Pick the agent for a rotation cursor. Agents are the CURRENT active roster in
 * a department (deterministic order), so `cursor % length` cycles A-B-A-B and
 * adapts automatically when the roster changes. Empty roster -> null (the
 * conversation stays unassigned).
 */
export function pickByRotation(agents, cursor) {
  if (!agents || !agents.length) return null
  const n = Number(cursor)
  const len = agents.length
  // Safe for any integer cursor, even a hypothetical negative.
  return agents[((n % len) + len) % len]
}

/**
 * Which department a SYNCED conversation should be auto-assigned to, or null to
 * leave it unassigned. Applies only to the sync path:
 *   - already assigned            -> null (never auto-reassign)
 *   - group                       -> null (auto-assignment is 1:1 only)
 *   - not created by sync         -> null (a fresh/webhook lead is handled at
 *                                    creation and never department-assigned)
 *   - department unclear / null   -> null (stays unassigned, flagged for manual)
 *   - 'sales' | 'operations'      -> that department
 */
export function eligibleSyncedDepartment({ assigned_user_id, is_group, created_source, department }) {
  if (assigned_user_id != null) return null
  if (is_group) return null
  if (created_source !== 'sync') return null
  return ASSIGNABLE_DEPARTMENTS.includes(department) ? department : null
}

// --------------------------------------------------------------------
// DB-backed assignment.
// --------------------------------------------------------------------

/** Active agents in a department, deterministic order for a stable cycle. */
export async function activeAgentsIn(db, department) {
  return (
    unwrap(
      await db
        .from('wp_chat_users')
        .select('id, name')
        .eq('role', 'agent')
        .eq('is_active', true)
        .eq('department', department)
        .order('id', { ascending: true })
    ) || []
  )
}

/** Atomic per-department cursor. Distinct value per call -> distinct agents. */
async function nextRotation(db, department) {
  const { data, error } = await db.rpc('wp_chat_next_rotation', { p_department: department })
  if (error) throw new Error(error.message)
  return Number(data)
}

/**
 * Round-robin assign one conversation to an active agent in `department`, but
 * ONLY if it is still unassigned. Returns { assigned, agent } | { assigned:false,
 * reason }. Never assigns to a deactivated/removed agent (the roster query
 * filters is_active), and never double-assigns (the conditional claim below).
 *
 * The rotation is advanced only when there is at least one active agent, so an
 * empty department neither errors nor burns a slot.
 */
export async function autoAssign(db, conversationId, department) {
  if (!ASSIGNABLE_DEPARTMENTS.includes(department)) return { assigned: false, reason: 'no_department' }

  const agents = await activeAgentsIn(db, department)
  if (!agents.length) return { assigned: false, reason: 'no_active_agents' }

  const cursor = await nextRotation(db, department)
  const agent = pickByRotation(agents, cursor)

  // Conditional claim: only assign if STILL unassigned. This is the idempotency
  // + concurrency guard — a manual assignment or a racing auto-assign that got
  // there first leaves this a no-op rather than clobbering it.
  const claimed =
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          assigned_user_id: agent.id,
          assigned_to: agent.name,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId)
        .is('assigned_user_id', null)
        .select('id')
    ) || []

  if (!claimed.length) return { assigned: false, reason: 'already_assigned', agent }
  return { assigned: true, agent }
}
