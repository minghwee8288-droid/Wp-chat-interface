import { query } from '../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { json, badRequest, serverError } from '../_lib/respond.js'

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const conversationId = Number(url.searchParams.get('conversation_id'))
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const messages = await query(
      env,
      `select id, conversation_id, direction, from_number, to_number, body,
              whapi_message_id, status, error_code, is_read, sent_by, created_at
         from wp_chat_messages
        where conversation_id = $1
        order by created_at asc, id asc`,
      [conversationId]
    )

    // Opening a thread marks it read.
    await query(
      env,
      `update wp_chat_conversations set unread_count = 0, updated_at = now() where id = $1`,
      [conversationId]
    )

    return json({ ok: true, conversation: access.conversation, messages })
  } catch (err) {
    return serverError(err.message || 'Failed to load messages')
  }
}
