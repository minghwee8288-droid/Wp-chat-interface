import { getDb, unwrap } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { json, badRequest, notFound, serverError, readJson } from '../../_lib/respond.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const validDate = (s) => DATE_RE.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

/**
 * POST /api/sync/start  (admin)
 *
 * Body — one of:
 *   { "type": "conversation", "conversation_id": 42 }
 *   { "type": "range", "from": "2026-04-01", "to": "2026-07-01" }
 *
 * Creates a sync job and returns it. Does no Whapi work — the client then
 * drives /api/sync/step until the job reports done.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const body = await readJson(request)
  const type = String(body?.type || '')

  let scope
  try {
    if (type === 'conversation') {
      const conversationId = positiveInt(body.conversation_id)
      if (!conversationId) return badRequest('conversation_id is required')

      const db = getDb(env)
      const conversation = unwrap(
        await db
          .from('wp_chat_conversations')
          .select('id, customer_number, is_group, group_jid, customer_name')
          .eq('id', conversationId)
          .maybeSingle()
      )
      if (!conversation) return notFound('Conversation not found')

      // Whapi chat id: the group JID as-is, or <number>@s.whatsapp.net for 1:1.
      const chatId = conversation.is_group
        ? conversation.group_jid
        : `${conversation.customer_number}@s.whatsapp.net`

      if (!chatId || (!conversation.is_group && !conversation.customer_number)) {
        return badRequest('This conversation cannot be synced (no chat id)')
      }

      scope = {
        type: 'conversation',
        conversation_id: conversationId,
        chat_id: chatId,
        name: conversation.customer_name || null,
      }
    } else if (type === 'range') {
      if (!validDate(body.from) || !validDate(body.to)) {
        return badRequest('from and to must be YYYY-MM-DD dates')
      }
      if (body.from > body.to) return badRequest('from must be on or before to')
      scope = { type: 'range', from: body.from, to: body.to }
    } else {
      return badRequest('type must be "conversation" or "range"')
    }

    const db = getDb(env)
    const job = unwrap(
      await db
        .from('wp_chat_sync_jobs')
        .insert({
          status: 'pending',
          scope,
          cursor: {},
          created_by: auth.user.id,
        })
        .select('*')
        .single()
    )

    return json({ ok: true, job })
  } catch (err) {
    return serverError(err.message || 'Failed to start sync')
  }
}
