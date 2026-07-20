import { getDb, unwrap } from '../_lib/db.js'
import { requireAdmin } from '../_lib/auth.js'
import { json, badRequest, notFound, serverError, readJson } from '../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const { conversation_id, assigned_user_id } = await readJson(request)

  const conversationId = Number(conversation_id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }

  const unassign =
    assigned_user_id === null || assigned_user_id === undefined || assigned_user_id === ''
  const userId = unassign ? null : Number(assigned_user_id)
  if (!unassign && (!Number.isInteger(userId) || userId <= 0)) {
    return badRequest('assigned_user_id must be a user id or null')
  }

  try {
    const db = getDb(env)

    let assignedName = null
    if (!unassign) {
      const agent = unwrap(
        await db
          .from('wp_chat_users')
          .select('id, name')
          .eq('id', userId)
          .eq('is_active', true)
          .maybeSingle()
      )
      if (!agent) return badRequest('That user does not exist or is inactive')
      assignedName = agent.name
    }

    // assigned_to is a denormalized copy of the agent's name — keep it in step.
    const conversation = unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          assigned_user_id: userId,
          assigned_to: assignedName,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId)
        .select('id, assigned_user_id, assigned_to')
        .maybeSingle()
    )

    if (!conversation) return notFound('Conversation not found')

    return json({ ok: true, conversation })
  } catch (err) {
    return serverError(err.message || 'Failed to assign conversation')
  }
}
