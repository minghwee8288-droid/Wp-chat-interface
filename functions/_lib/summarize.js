import { getDb, unwrap, UNIQUE_VIOLATION } from './db.js'
import {
  decideRefresh,
  produceSummary,
  AiError,
  FIRST_MESSAGE_CAP,
  INCREMENTAL_MESSAGE_CAP,
  SEED_WINDOW_DAYS,
} from './ai.js'

// The ONE shared summary generator, used by the endpoint, the inbound webhook,
// and the seed script — extracted verbatim from the endpoint so there is zero
// drift. It owns nothing new: the dormant guard + 6-hour gate + first/incremental
// choice all come from decideRefresh, and the prompt/model come from
// produceSummary. It ONLY reads messages and writes wp_chat_summaries.

// A generation holds the lease for at most this long; a crashed run frees it
// after this window so a conversation can never be stuck "generating".
export const LEASE_MS = 120 * 1000

const SUMMARY_MSG_COLUMNS = 'id, direction, body, sender_name, media_type, media_caption, created_at'

/**
 * Bring one conversation's summary up to date per the existing rules.
 *
 * Returns { action, row }:
 *   'empty'          — no messages and no summary; nothing done.
 *   'cached'         — dormant (no new messages) or within the 6-hour gate; NO model call.
 *   'generating'     — another run holds the lease; NO model call.
 *   'no_messages'    — decided to generate but the window was empty (raced a delete).
 *   'generated'      — a fresh summary was produced and saved (`row` is the new row).
 *   'refresh_failed' — the model/parse failed; the last good `row` is kept.
 *
 * Never throws on an AiError. `db` is injectable so a caller can share a client.
 */
export async function refreshConversationSummary(env, conversationId, isGroup, db = getDb(env)) {
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

  if (decision.action === 'empty') return { action: 'empty', row: null }
  if (decision.action === 'cached') return { action: 'cached', row: summaryRow }

  // --- generate: claim the lease atomically -----------------------------
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

  if (!haveLease) return { action: 'generating', row: summaryRow }

  const releaseLease = () =>
    db
      .from('wp_chat_summaries')
      .update({ lease_until: null })
      .eq('conversation_id', conversationId)
      .then(() => {})
      .catch(() => {})

  try {
    // Gather the messages to send, ordered by id so the cursor and ordering
    // agree; always oldest-first for the prompt. INCREMENTAL: only ids past the
    // cursor (newest N). FIRST: the last SEED_WINDOW_DAYS (newest N), falling
    // back to newest N of all when the window is empty.
    const base = () =>
      db
        .from('wp_chat_messages')
        .select(SUMMARY_MSG_COLUMNS)
        .eq('conversation_id', conversationId)
        .order('id', { ascending: false })

    let desc
    if (decision.mode === 'incremental') {
      desc =
        unwrap(await base().gt('id', summaryRow.last_summarized_message_id ?? 0).limit(INCREMENTAL_MESSAGE_CAP)) || []
    } else {
      const cutoff = new Date(Date.now() - SEED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
      desc = unwrap(await base().gte('created_at', cutoff).limit(FIRST_MESSAGE_CAP)) || []
      if (!desc.length) desc = unwrap(await base().limit(FIRST_MESSAGE_CAP)) || []
    }
    const messages = desc.reverse()

    if (!messages.length) {
      await releaseLease()
      return { action: 'no_messages', row: summaryRow }
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

    return { action: 'generated', row: saved }
  } catch (err) {
    await releaseLease()
    if (err instanceof AiError) return { action: 'refresh_failed', row: summaryRow }
    throw err
  }
}
