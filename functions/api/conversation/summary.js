import { getDb, unwrap, UNIQUE_VIOLATION } from '../../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../../_lib/auth.js'
import { json, badRequest, serverError } from '../../_lib/respond.js'
import { autoAssign, eligibleSyncedDepartment } from '../../_lib/assign.js'
import { notifyNewMessage } from '../../_lib/notify.js'
import {
  decideRefresh,
  produceSummary,
  AiError,
  FIRST_MESSAGE_CAP,
  INCREMENTAL_MESSAGE_CAP,
  SEED_WINDOW_DAYS,
} from '../../_lib/ai.js'

// A summary generation holds the lease for at most this long; a crashed request
// frees it after this window so a conversation can never be stuck "generating".
const LEASE_MS = 120 * 1000

// Only the columns a summary needs — never the full MESSAGE_COLUMNS. This
// endpoint reads messages and writes wp_chat_summaries and nothing else: it
// must not touch message rows, unread counts, or conversation state.
const SUMMARY_MSG_COLUMNS = 'id, direction, body, sender_name, media_type, media_caption, created_at'

const positiveInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Shape a stored row for the client, or null when there is no summary yet. The
 * panel shows the SHORT summary; the big summary is the memory (EOD report,
 * later phase) and is not sent to the panel.
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
 * _lib/ai.js (first summary of recent history; otherwise incremental from the
 * stored cursor; 6-hour staleness gate; never regenerate without new activity).
 * One generation in flight per conversation via a soft lease.
 */
/**
 * Phase-2 auto-assignment ride-along. A SYNCED, still-unassigned 1:1 is assigned
 * to its classified department once the summary has classified it; the newly
 * assigned agent gets the same push they'd get for a message. Never touches an
 * assigned conversation, a group, a webhook lead, or an 'unclear' one. Never
 * throws — it is a side effect of the summary, not part of it.
 */
async function maybeAutoAssignSynced(env, db, conversationId, saved) {
  try {
    const conv = unwrap(
      await db
        .from('wp_chat_conversations')
        .select('assigned_user_id, is_group, created_source, customer_name, customer_number, last_message_body')
        .eq('id', conversationId)
        .maybeSingle()
    )
    if (!conv) return
    const department = eligibleSyncedDepartment({
      assigned_user_id: conv.assigned_user_id,
      is_group: conv.is_group,
      created_source: conv.created_source,
      department: saved.department,
    })
    if (!department) return

    const result = await autoAssign(db, conversationId, department)
    if (!result.assigned) return

    // Reuse the message-push routing: assigned agent alone gets notified.
    await notifyNewMessage(env, {
      conversation: { id: conversationId, assigned_user_id: result.agent.id },
      message: { id: null, body: conv.last_message_body || '' },
      title: conv.customer_name || (conv.customer_number ? `+${conv.customer_number}` : 'New conversation'),
      senderName: null,
    })
  } catch (err) {
    console.error('auto-assign (synced) failed', conversationId, err?.message)
  }
}

export async function onRequestGet(context) {
  const { request, env } = context
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const conversationId = positiveInt(url.searchParams.get('conversation_id'))
  if (!conversationId) return badRequest('conversation_id is required')

  try {
    // Respects the existing access rules (agents see all; 404 if absent).
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response
    const isGroup = !!access.conversation.is_group

    const db = getDb(env)

    // Current stored summary (if any) and the newest message id.
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

    const decision = decideRefresh({
      summaryRow,
      latestMessageId,
      hasMessages: latestMessageId != null,
      now: Date.now(),
    })

    if (decision.action === 'empty') return toClient(null, { empty: true })
    if (decision.action === 'cached') return toClient(summaryRow)

    // --- action === 'generate' -------------------------------------------
    // Claim the lease atomically: a single UPDATE that only matches when the
    // lease is free. If it matches nothing and no row exists yet, insert one
    // holding the lease; a unique-violation there means another request won the
    // race. Either way, losing the race returns the cached summary (possibly
    // null) with generating:true — it never fires a second model call.
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const leaseIso = new Date(nowMs + LEASE_MS).toISOString()

    const claimed =
      unwrap(
        await db
          .from('wp_chat_summaries')
          .update({ lease_until: leaseIso, updated_at: nowIso })
          .eq('conversation_id', conversationId)
          .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
          .select('*')
      ) || []
    let haveLease = claimed.length > 0

    if (!haveLease && !summaryRow) {
      try {
        const inserted = unwrap(
          await db
            .from('wp_chat_summaries')
            .insert({ conversation_id: conversationId, lease_until: leaseIso })
            .select('*')
        )
        haveLease = Array.isArray(inserted) && inserted.length > 0
      } catch (err) {
        if (err.code !== UNIQUE_VIOLATION) throw err
        haveLease = false
      }
    }

    if (!haveLease) return toClient(summaryRow, { generating: true })

    // Release helper — the lease must be freed on every exit path from here.
    const releaseLease = () =>
      db
        .from('wp_chat_summaries')
        .update({ lease_until: null })
        .eq('conversation_id', conversationId)
        .then(() => {})
        .catch(() => {})

    try {
      // Gather the messages to send, ordered by id so the cursor and ordering
      // agree; always oldest-first for the prompt.
      //   INCREMENTAL: only ids past the cursor (newest N, truncating oldest-first).
      //   FIRST (seed): the last SEED_WINDOW_DAYS (newest N). If nothing falls in
      //     that window (an old, just-reopened chat), fall back to newest N of all
      //     so a first summary always seeds from something.
      const base = () =>
        db
          .from('wp_chat_messages')
          .select(SUMMARY_MSG_COLUMNS)
          .eq('conversation_id', conversationId)
          .order('id', { ascending: false })

      let desc
      if (decision.mode === 'incremental') {
        desc = unwrap(
          await base().gt('id', summaryRow.last_summarized_message_id ?? 0).limit(INCREMENTAL_MESSAGE_CAP)
        ) || []
      } else {
        const cutoff = new Date(Date.now() - SEED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
        desc = unwrap(await base().gte('created_at', cutoff).limit(FIRST_MESSAGE_CAP)) || []
        if (!desc.length) desc = unwrap(await base().limit(FIRST_MESSAGE_CAP)) || []
      }
      const messages = desc.reverse()

      if (!messages.length) {
        // Nothing to summarize after all (race with a delete). Free the lease
        // and return whatever we had.
        await releaseLease()
        return toClient(summaryRow)
      }

      const result = await produceSummary({
        env,
        mode: decision.mode,
        existingBigSummary: summaryRow?.big_summary || '',
        messages,
        isGroup,
      })

      const saved = unwrap(
        await db
          .from('wp_chat_summaries')
          .update({
            big_summary: result.big_summary,
            short_summary: result.short_summary,
            department: result.department,
            attention_required: result.attention_required,
            attention_level: result.attention_level,
            attention_reason: result.attention_reason,
            last_summarized_message_id: result.last_summarized_message_id,
            model: result.model,
            generated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            lease_until: null,
          })
          .eq('conversation_id', conversationId)
          .select('*')
          .single()
      )

      // Fire-and-forget auto-assignment so it never delays the summary response.
      const assignTask = maybeAutoAssignSynced(env, db, conversationId, saved)
      if (typeof context.waitUntil === 'function') context.waitUntil(assignTask)
      else await assignTask

      return toClient(saved, { generated: true })
    } catch (err) {
      await releaseLease()
      // Model or parse failure: never a hard error or blank panel — hand back
      // the last good summary (if any) with a quiet couldn't-refresh flag.
      if (err instanceof AiError) {
        return toClient(summaryRow, { refresh_failed: true })
      }
      throw err
    }
  } catch (err) {
    return serverError(err?.message || 'Failed to load summary')
  }
}
