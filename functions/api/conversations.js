import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth } from '../_lib/auth.js'
import { json, serverError } from '../_lib/respond.js'

const COLUMNS = `
  id, customer_number, business_number, customer_name,
  last_message_body, last_message_at, last_direction,
  unread_count, status, assigned_user_id, assigned_to,
  avatar_path, avatar_error,
  is_group, group_jid, member_count,
  created_at, updated_at
`

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  try {
    const db = getDb(env)

    // No role scoping: every authenticated user sees every conversation.
    // Assignment is a label, not a filter — the Assigned/Unassigned chips do
    // the narrowing client-side, and now mean something for agents too.
    const builder = db
      .from('wp_chat_conversations')
      .select(COLUMNS)
      // DESC NULLS LAST
      .order('last_message_at', { ascending: false, nullsFirst: false })

    const conversations = unwrap(await builder) || []

    // Resolve assignee names in one extra round trip rather than an embedded
    // select, so this doesn't depend on PostgREST inferring the FK relationship.
    const assigneeIds = [
      ...new Set(conversations.map((c) => c.assigned_user_id).filter((id) => id != null)),
    ]

    let names = new Map()
    if (assigneeIds.length) {
      const users =
        unwrap(
          await db.from('wp_chat_users').select('id, name').in('id', assigneeIds)
        ) || []
      names = new Map(users.map((u) => [String(u.id), u.name]))
    }

    return json({
      ok: true,
      conversations: conversations.map((c) => ({
        ...c,
        // Prefer the live name, fall back to the denormalized copy.
        assigned_to: names.get(String(c.assigned_user_id)) ?? c.assigned_to ?? null,
      })),
    })
  } catch (err) {
    return serverError(err.message || 'Failed to load conversations')
  }
}
