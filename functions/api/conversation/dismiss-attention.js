import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * POST /api/conversation/dismiss-attention  { conversation_id }
 *
 * Manually clears the attention flag on one conversation — for when an agent
 * resolved the issue off-channel and the AI, never having seen it resolved,
 * keeps the row flagged. Any signed-in user may dismiss; the action is scoped
 * to the one conversation.
 *
 * It only writes wp_chat_summaries: attention is cleared and the dismissal is
 * stamped (dismissed_at / dismissed_by). The stamp is what lets a later
 * regenerate distinguish "already handled" from "a new issue arrived" —
 * summarize.js suppresses re-flagging until a message lands AFTER dismissed_at.
 *
 * A conversation with no summary row yet has nothing flagged, so the UPDATE
 * simply matches nothing and we still report ok — dismissing an unflagged
 * conversation is a harmless no-op, not an error.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  let payload
  try {
    payload = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const conversationId = positiveInt(payload?.conversation_id)
  if (!conversationId) return badRequest('conversation_id is required')

  try {
    // Same access rule as the summary endpoint: 404 if the conversation is
    // absent, otherwise every agent may act on it.
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const db = getDb(env)

    unwrap(
      await db
        .from('wp_chat_summaries')
        .update({
          attention_required: false,
          attention_level: null,
          attention_reason: null,
          dismissed_at: new Date().toISOString(),
          dismissed_by: auth.user.id,
          updated_at: new Date().toISOString(),
        })
        .eq('conversation_id', conversationId)
    )

    return json({ ok: true, conversation_id: conversationId })
  } catch (err) {
    return serverError(err?.message || 'Failed to dismiss attention')
  }
}
