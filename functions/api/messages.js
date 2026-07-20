import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { MESSAGE_COLUMNS } from '../_lib/storage.js'
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

    const db = getDb(env)

    const messages =
      unwrap(
        await db
          .from('wp_chat_messages')
          .select(MESSAGE_COLUMNS)
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
      ) || []

    // Opening a thread marks it read.
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({ unread_count: 0, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
    )

    return json({ ok: true, conversation: access.conversation, messages })
  } catch (err) {
    return serverError(err.message || 'Failed to load messages')
  }
}
