import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { getDb, unwrap } from '../../_lib/db.js'
import { decideRefresh } from '../../_lib/ai.js'
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
 * NEVER awaits the model. The request path is two tiny indexed reads plus the
 * pure decideRefresh() classification; when a refresh is due the model call is
 * handed to ctx.waitUntil() so it runs AFTER the response is flushed. The client
 * gets the stored (possibly stale) row immediately with `generating: true` and
 * polls back for the fresh text.
 *
 * This is the whole fix for the ~14s open: the browser used to hold the
 * connection open for the entire OpenRouter generation, and opening the inbox
 * fires several of these at once. Access rules are unchanged.
 */
export async function onRequestGet({ request, env, waitUntil }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const conversationId = positiveInt(url.searchParams.get('conversation_id'))
  if (!conversationId) return badRequest('conversation_id is required')

  try {
    // Respects the existing access rules (agents see all; 404 if absent).
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response

    // One client, shared with the background refresh below so the deferred work
    // reuses this isolate's warm connection instead of building a second one.
    const db = getDb(env)

    // --- the two fast reads (milliseconds, both index-backed) -------------
    const summaryRow = unwrap(
      await db.from('wp_chat_summaries').select('*').eq('conversation_id', conversationId).maybeSingle()
    )
    const latestRows =
      unwrap(
        await db
          .from('wp_chat_messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .order('id', { ascending: false })
          .limit(1)
      ) || []
    const latestMessageId = latestRows.length ? latestRows[0].id : null

    // --- classify without touching the model ------------------------------
    const decision = decideRefresh({
      summaryRow,
      latestMessageId,
      hasMessages: latestMessageId != null,
      now: Date.now(),
    })

    if (decision.action === 'empty') return toClient(null, { empty: true })
    if (decision.action === 'cached') return toClient(summaryRow)

    // --- generate ---------------------------------------------------------
    // Whether we can defer the model call depends entirely on whether we have
    // something to show in the meantime.
    const hasText = !!(summaryRow && summaryRow.short_summary && summaryRow.short_summary.trim())

    if (hasText) {
      // A REFRESH of text we already have. Deferring is free: the client gets
      // the current wording immediately and simply polls for the newer one. If
      // the background run dies, the stored row is untouched and still good.
      const deferred = refreshConversationSummary(
        env,
        conversationId,
        !!access.conversation.is_group,
        db
      ).catch(() => {})

      if (typeof waitUntil === 'function') waitUntil(deferred)

      return toClient(summaryRow, { generating: true })
    }

    // A FIRST generation — there is no stored text to fall back on. This MUST
    // complete in the request.
    //
    // Deferring it here is what produced permanently-"Summarizing…" rows:
    // refreshConversationSummary first INSERTS a placeholder row (blank
    // short/big_summary, model null) to claim its lease, then calls the model.
    // If the isolate is torn down before the model returns — which is exactly
    // what happens under `wrangler pages dev`, and can happen on a cold/limited
    // isolate in production — the final update never lands. The blank row then
    // survives, and because decideRefresh() treats "no big and no short" as a
    // first generation it IGNORES the 2h gate, so every later open regenerates
    // and dies the same way. The row can never fill in.
    //
    // Waiting costs this one request the model latency, but it is the only
    // request that pays it: once the row has text, every future open takes the
    // fast cached/refresh path above.
    const { action, row } = await refreshConversationSummary(
      env,
      conversationId,
      !!access.conversation.is_group,
      db
    )

    switch (action) {
      case 'empty':
        return toClient(null, { empty: true })
      case 'generating':
        // Another request holds the lease and is generating right now; it will
        // land shortly, so the client polls rather than starting a second run.
        return toClient(row, { generating: true })
      case 'refresh_failed':
        return toClient(row, { refresh_failed: true })
      default: // 'generated' | 'cached' | 'no_messages'
        return toClient(row, action === 'generated' ? { generated: true } : {})
    }
  } catch (err) {
    return serverError(err?.message || 'Failed to load summary')
  }
}
