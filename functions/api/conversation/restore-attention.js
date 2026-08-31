import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * POST /api/conversation/restore-attention  { conversation_id }
 *
 * The Undo of a manual dismissal. dismiss-attention leaves attention_level and
 * attention_reason in the row and only flips attention_required to false, so
 * restoring is just flipping it back to true and clearing the dismissal stamp —
 * the original level and reason are already there.
 *
 * Any signed-in user may undo; the action is scoped to the one conversation.
 * A conversation with no summary row matches nothing and still reports ok.
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
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const db = getDb(env)

    unwrap(
      await db
        .from('wp_chat_summaries')
        .update({
          attention_required: true,
          // level / reason were retained by the dismiss, so nothing else to set.
          dismissed_at: null,
          dismissed_by: null,
          updated_at: new Date().toISOString(),
        })
        .eq('conversation_id', conversationId)
    )

    return json({ ok: true, conversation_id: conversationId })
  } catch (err) {
    return serverError(err?.message || 'Failed to restore attention')
  }
}
