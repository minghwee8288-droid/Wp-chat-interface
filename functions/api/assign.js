import { queryOne } from '../_lib/db.js'
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

  const unassign = assigned_user_id === null || assigned_user_id === undefined || assigned_user_id === ''
  const userId = unassign ? null : Number(assigned_user_id)
  if (!unassign && (!Number.isInteger(userId) || userId <= 0)) {
    return badRequest('assigned_user_id must be a user id or null')
  }

  try {
    let assignedName = null
    if (!unassign) {
      const agent = await queryOne(
        env,
        `select id, name from wp_chat_users where id = $1 and is_active = true`,
        [userId]
      )
      if (!agent) return badRequest('That user does not exist or is inactive')
      assignedName = agent.name
    }

    // assigned_to is denormalized for n8n's convenience — keep it in step.
    const conversation = await queryOne(
      env,
      `update wp_chat_conversations
          set assigned_user_id = $1,
              assigned_to = $2,
              updated_at = now()
        where id = $3
       returning id, assigned_user_id, assigned_to`,
      [userId, assignedName, conversationId]
    )

    if (!conversation) return notFound('Conversation not found')

    return json({ ok: true, conversation })
  } catch (err) {
    return serverError(err.message || 'Failed to assign conversation')
  }
}
