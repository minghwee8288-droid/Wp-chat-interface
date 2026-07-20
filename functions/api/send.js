import { query, queryOne } from '../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { json, badRequest, serverError, readJson } from '../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { conversation_id, body } = await readJson(request)

  const conversationId = Number(conversation_id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }
  if (typeof body !== 'string' || !body.trim()) {
    return badRequest('Message body is required')
  }
  const text = body.trim()

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response
    const conversation = access.conversation

    // (a) Queue the outbound row.
    const message = await queryOne(
      env,
      `insert into wp_chat_messages
         (conversation_id, direction, from_number, to_number, body, status, is_read, sent_by, created_at)
       values ($1, 'outbound', $2, $3, $4, 'queued', true, $5, now())
       returning id, conversation_id, direction, from_number, to_number, body,
                 whapi_message_id, status, error_code, is_read, sent_by, created_at`,
      [
        conversationId,
        conversation.business_number,
        conversation.customer_number,
        text,
        auth.user.name,
      ]
    )

    // (b) Keep the list preview in sync.
    await query(
      env,
      `update wp_chat_conversations
          set last_message_body = $1,
              last_message_at = now(),
              last_direction = 'outbound',
              updated_at = now()
        where id = $2`,
      [text, conversationId]
    )

    // (c) Hand off to n8n, which talks to Whapi. The app never calls Whapi itself.
    try {
      if (!env.N8N_OUTBOUND_WEBHOOK_URL) {
        throw new Error('N8N_OUTBOUND_WEBHOOK_URL is not configured')
      }

      const res = await fetch(env.N8N_OUTBOUND_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          to_number: conversation.customer_number,
          body: text,
          message_id: message.id,
        }),
      })
      if (!res.ok) throw new Error(`n8n webhook returned ${res.status}`)

      await query(env, `update wp_chat_messages set status = 'sent' where id = $1`, [
        message.id,
      ])
      message.status = 'sent'
    } catch (webhookErr) {
      // (d) Make the failure visible rather than silently leaving it queued.
      await query(
        env,
        `update wp_chat_messages set status = 'send_failed', error_code = $1 where id = $2`,
        [String(webhookErr.message || 'webhook_error').slice(0, 200), message.id]
      )
      message.status = 'send_failed'
      message.error_code = String(webhookErr.message || 'webhook_error').slice(0, 200)
    }

    return json({ ok: true, message })
  } catch (err) {
    return serverError(err.message || 'Failed to send message')
  }
}
