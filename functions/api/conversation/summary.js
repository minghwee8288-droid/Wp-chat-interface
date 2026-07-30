import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { refreshConversationSummary } from '../../_lib/summarize.js'

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Shape a stored row for the client, or null when there is no summary yet. The
 * panel shows the SHORT summary; the big summary is the memory (EOD report) and
 * is not sent to the panel.
 */
function toClient(row, extra = {}) {
  const summary =
    row && row.short_summary && row.short_summary.trim()
      ? {
          text: row.short_summary,
          department: row.department || null,
          attention_required: !!row.attention_required,
          attention_level: row.attention_level || null,
          attention_reason: row.attention_reason || null,
          generated_at: row.generated_at || null,
          model: row.model || null,
        }
      : null
  return json({ ok: true, summary, ...extra })
}

/**
 * GET /api/conversation/summary?conversation_id=N
 *
 * Returns the conversation's summary, generating or refreshing per the rules in
 * _lib/ai.js — now via the shared refreshConversationSummary() (the same code
 * the inbound webhook and the seed script use). Access rules unchanged.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const conversationId = positiveInt(url.searchParams.get('conversation_id'))
  if (!conversationId) return badRequest('conversation_id is required')

  try {
    // Respects the existing access rules (agents see all; 404 if absent).
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    const { action, row } = await refreshConversationSummary(
      env,
      conversationId,
      !!access.conversation.is_group
    )

    switch (action) {
      case 'empty':
        return toClient(null, { empty: true })
      case 'generating':
        return toClient(row, { generating: true })
      case 'generated':
        return toClient(row, { generated: true })
      case 'refresh_failed':
        return toClient(row, { refresh_failed: true })
      default: // 'cached' | 'no_messages'
        return toClient(row)
    }
  } catch (err) {
    return serverError(err?.message || 'Failed to load summary')
  }
}
