// Missed-message / historical backfill engine.
//
// DESIGN — client-driven cooperative chunking (no cron, no long request).
//
// A long backfill cannot run inside one request: Cloudflare Workers cap
// wall-clock and subrequests, and Pages has no cron to hand it off to. So the
// work is split into bounded STEPS that the admin UI drives:
//
//   POST /api/sync/start  -> creates a job row, returns it
//   POST /api/sync/step   -> does ONE bounded unit, advances the cursor, returns progress
//   (repeat step until done)
//   GET  /api/sync/status -> poll the row (also survives a page reload)
//
// Each step is a fresh short request, so the runtime limits never bind, and
// the cursor lives in the row, so the whole thing is resumable. This same
// machinery serves both a five-minute outage gap and a three-month import —
// the only difference is the scope and how many steps it takes.
//
// HISTORICAL POLICY (differs from live inbound on purpose):
//   * is_read = true            — a backfilled message is NOT unread, so a
//                                 sync never inflates a badge.
//   * last_message_at is bumped ONLY when the synced message is NEWER than the
//     conversation's current last message — an old message never reorders the
//     list or overwrites a fresher preview.
//   * no push — notifyNewMessage is never called from here, so a backfill
//     cannot fire a flood of notifications.
//   * dedup on whapi_message_id (already unique) — an already-present message
//     hits the constraint and is skipped, never written twice.

import { unwrap, UNIQUE_VIOLATION } from './db.js'
import { listMessages, listChats, redactPayload } from './whapi.js'
import {
  shapeInboundMessage,
  ingestAttachment,
  findOrCreateGroup,
  findOrCreateConversation,
  previewLine,
  mediaPreviewLabel,
} from './ingest.js'

// Messages pulled and processed per step. Deliberately small: a step may fetch
// and re-host up to this many media attachments sequentially, and every step
// must finish comfortably inside a Worker's limits. The client just runs more
// steps — throughput is unchanged, latency per request stays low.
const STEP_MESSAGES = 15

// Chats pulled per /chats page during a range sync. Cached in the cursor and
// drained one chat at a time, so /chats is hit once per this many chats.
const CHATS_PAGE = 50

/** YYYY-MM-DD -> unix seconds at the START of that day (UTC). */
function dayStartUnix(date) {
  const ms = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}
/** YYYY-MM-DD -> unix seconds at the END of that day (UTC), inclusive. */
function dayEndUnix(date) {
  const ms = Date.parse(`${date}T23:59:59Z`)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * Whapi's per-message delivery status -> our `status` column.
 *
 * We store only what Whapi reports, mapped onto the small set the app already
 * understands: a failed send stays distinguishable, everything else that made
 * it into Whapi's history was sent. We do not invent a delivery state.
 */
function outboundStatus(msg) {
  const s = String(msg?.status || '').toLowerCase()
  if (s === 'failed' || s === 'error') return 'send_failed'
  return 'sent'
}

/**
 * Who/what sent an outbound message, if Whapi says. Stored in the EXISTING
 * sent_by column (no new column). Whapi does not know our internal agents, so
 * this is the account/device name when present, else null.
 */
function outboundSentBy(msg) {
  const candidate = [msg?.from_name, msg?.source, msg?.device].find(
    (v) => typeof v === 'string' && v.trim()
  )
  return candidate ? candidate.trim().slice(0, 255) : null
}

/**
 * Store one historical message — INBOUND or OUTBOUND. Returns
 *   { added, duplicate, skipped, mediaFailed, error }
 * and never throws for an expired attachment — that degrades to media_error
 * exactly as a live failure does.
 */
export async function persistHistorical(env, db, msg, chatName) {
  // allowOutbound: sync keeps our own sent messages (the live webhook drops
  // them as echoes). This is what was missing — replies never got written.
  const shaped = shapeInboundMessage(msg, env, { allowOutbound: true })

  // DIAGNOSTIC: trace every raw from_me message through shaping so a run shows,
  // per message, whether the fromMe flag survived into persistence and which
  // direction it will be written as — the exact "computed and discarded?"
  // question. If shapedFromMe is ever false or skip is set for a from_me
  // message, this line pinpoints it.
  if (msg?.from_me === true) {
    console.log(
      'sync.diag.outbound ' +
        JSON.stringify({
          id: msg?.id ?? null,
          type: msg?.type ?? null,
          rawFromMe: msg.from_me,
          shapedFromMe: shaped.fromMe ?? null,
          skip: shaped.skip ?? null,
          direction: shaped.skip ? null : shaped.fromMe ? 'outbound' : 'inbound',
        })
    )
  }

  if (shaped.skip) return { added: false, skipped: true, reason: shaped.skip }

  const {
    fromMe, groupJid, sender, customerNumber, customerName,
    whapiMessageId, body, createdAt, explicitMedia, attachment, businessNumber,
  } = shaped

  const conversation = groupJid
    ? await findOrCreateGroup(db, groupJid, businessNumber, chatName)
    : await findOrCreateConversation(db, customerNumber, businessNumber, customerName)

  // Same fetch-and-store pipeline for BOTH directions. An expired media id
  // (common on year-old messages) comes back as media_error rather than
  // throwing, and the message is still written with its text intact.
  let media = explicitMedia
  let mediaError = null
  if (attachment) {
    const ingested = await ingestAttachment(env, conversation.id, attachment)
    media = ingested.media
    mediaError = ingested.error
  }

  // Direction-specific columns. The recipient of an outbound message is the
  // conversation counterparty (the group JID, or the customer's number).
  const directionRow = fromMe
    ? {
        direction: 'outbound',
        from_number: businessNumber,
        to_number: groupJid || customerNumber,
        sender_number: null,
        sender_name: null,
        status: outboundStatus(msg),
        sent_by: outboundSentBy(msg),
      }
    : {
        direction: 'inbound',
        from_number: groupJid ? sender.number : customerNumber,
        to_number: businessNumber,
        sender_number: groupJid ? sender.number : null,
        sender_name: groupJid ? sender.name : null,
        status: 'received',
        sent_by: null,
      }

  const inserted = await db
    .from('wp_chat_messages')
    .insert({
      conversation_id: conversation.id,
      ...directionRow,
      body,
      whapi_message_id: whapiMessageId,
      // Historical messages are considered already-read in BOTH directions: a
      // backfill must never inflate unread counts, and our own replies are read
      // by definition (this matches /api/send, which stores is_read: true).
      is_read: true,
      created_at: createdAt,
      ...(mediaError ? { error_code: mediaError.slice(0, 200) } : {}),
      ...(media ? { ...media, media_caption: body } : {}),
    })
    .select('id')
    .single()

  if (inserted.error) {
    // Already synced (or, for outbound, already written live by /api/send): the
    // unique whapi_message_id makes this a no-op — the dedup guarantee, and the
    // reason an outbound message already in the DB is never doubled.
    if (inserted.error.code === UNIQUE_VIOLATION) {
      return { added: false, duplicate: true, direction: fromMe ? 'outbound' : 'inbound' }
    }
    throw new Error(inserted.error.message)
  }

  // Preview/order guard: only move last_message_at FORWARD. An old message must
  // never jump a conversation to the top or clobber a newer preview. Unread is
  // intentionally left untouched.
  //
  // Outbound gets NO group-sender prefix — the list adds "You: " itself from
  // last_direction, exactly as it does for a live reply.
  const preview = fromMe
    ? body || mediaPreviewLabel(media)
    : previewLine(groupJid, sender, body, media)

  const conv = unwrap(
    await db.from('wp_chat_conversations').select('last_message_at').eq('id', conversation.id).maybeSingle()
  )
  const existingAt = conv?.last_message_at ? new Date(conv.last_message_at).getTime() : 0
  if (new Date(createdAt).getTime() > existingAt) {
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          last_message_body: preview,
          last_message_at: createdAt,
          last_direction: fromMe ? 'outbound' : 'inbound',
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation.id)
    )
  }

  return { added: true, direction: fromMe ? 'outbound' : 'inbound', mediaFailed: Boolean(mediaError) }
}

/**
 * Process a batch of raw messages, honouring an optional time window.
 *
 * DIAGNOSTIC: logs one `sync.diag.classify` line per page — returned vs how
 * many were classified inbound/outbound, added, deduped, window-skipped, and
 * skipped-with-reason. A run that silently drops every outbound message no
 * longer looks identical to a healthy one; the counts show it.
 */
async function ingestBatch(env, db, messages, chatName, windowSec, chatId = '') {
  let added = 0
  let mediaFailed = 0
  const stats = { returned: messages.length, inbound: 0, outbound: 0, added: 0, duplicate: 0, windowSkipped: 0, skipped: 0, reasons: {} }

  for (const msg of messages) {
    // Defensive window filter: even if Whapi ignores time_from/time_to, an
    // out-of-range message is skipped so a range sync stays within its dates.
    if (windowSec) {
      const ts = Number(msg?.timestamp)
      if (Number.isFinite(ts)) {
        if (windowSec.from && ts < windowSec.from) { stats.windowSkipped++; continue }
        if (windowSec.to && ts > windowSec.to) { stats.windowSkipped++; continue }
      }
    }
    const r = await persistHistorical(env, db, msg, chatName)
    if (r.direction === 'inbound') stats.inbound++
    else if (r.direction === 'outbound') stats.outbound++
    if (r.added) { added++; stats.added++ }
    if (r.mediaFailed) mediaFailed++
    if (r.duplicate) stats.duplicate++
    if (r.skipped) {
      stats.skipped++
      // Break the generic non_text skip down by message type, so contact /
      // action (reactions, edits) / system (revoked) are visible distinctly
      // rather than lumped together.
      const key = r.reason === 'non_text' ? `non_text:${msg?.type || 'unknown'}` : r.reason
      stats.reasons[key] = (stats.reasons[key] || 0) + 1
    }
  }

  console.log('sync.diag.classify ' + JSON.stringify({ chat: chatId, ...stats }))

  return { added, mediaFailed }
}

/**
 * DIAGNOSTIC: dump the raw Whapi response for the first page of a chat, with
 * only token-shaped keys redacted (redactPayload preserves from/from_me/author/
 * chat_id/source so the real direction encoding is visible). Bounded to one
 * page (≤ STEP_MESSAGES) and only on offset 0, so it does not flood.
 */
function logRawPage(chatId, offset, messages) {
  if (offset !== 0) return
  console.log(
    'sync.diag.raw ' +
      JSON.stringify({ chat: chatId, count: messages.length, messages: messages.map(redactPayload) })
  )
}

/**
 * One bounded step of a job. Pure-ish: reads Whapi + the DB, returns a patch
 * for the caller to persist. Does NOT write the job row itself.
 *
 * Returns { done, cursor, addAdded, addMediaFailed, addConversationsDone, error }.
 */
export async function runSyncStep(env, db, job) {
  const scope = job.scope || {}
  const cursor = job.cursor || {}

  if (scope.type === 'conversation') {
    return stepConversation(env, db, scope, cursor)
  }
  if (scope.type === 'range') {
    return stepRange(env, db, scope, cursor)
  }
  return { done: true, cursor, error: `unknown scope type: ${scope.type}` }
}

async function stepConversation(env, db, scope, cursor) {
  const offset = Number(cursor.offset) || 0
  const list = await listMessages(env, scope.chat_id, { offset, count: STEP_MESSAGES })

  if (!list.ok) {
    // A dead chat ends this (single-conversation) job with the error recorded.
    return {
      done: true,
      cursor: { ...cursor, offset },
      error: list.error,
      addConversationsDone: 0,
    }
  }

  logRawPage(scope.chat_id, offset, list.messages)
  const { added, mediaFailed } = await ingestBatch(env, db, list.messages, scope.name, null, scope.chat_id)
  const nextOffset = offset + list.messages.length
  const done = list.messages.length < STEP_MESSAGES

  return {
    done,
    cursor: { offset: nextOffset },
    addAdded: added,
    addMediaFailed: mediaFailed,
    addConversationsDone: done ? 1 : 0,
  }
}

async function stepRange(env, db, scope, cursor) {
  const from = dayStartUnix(scope.from)
  const to = dayEndUnix(scope.to)
  const windowSec = { from, to }

  const state = {
    chatOffset: Number(cursor.chatOffset) || 0,
    pending: Array.isArray(cursor.pending) ? cursor.pending : [],
    current: cursor.current || null,
    chatsExhausted: Boolean(cursor.chatsExhausted),
  }

  // 1. Need a chat to work on? Seed from /chats (one page cached in the cursor).
  if (!state.current && state.pending.length === 0) {
    if (state.chatsExhausted) {
      return { done: true, cursor: state } // nothing left anywhere
    }
    const page = await listChats(env, { offset: state.chatOffset, count: CHATS_PAGE })
    if (!page.ok) {
      return { done: false, cursor: state, error: page.error, backoff: true }
    }
    state.pending = page.chats
    state.chatOffset += page.chats.length
    if (page.chats.length < CHATS_PAGE) state.chatsExhausted = true
    if (state.pending.length === 0) {
      return { done: state.chatsExhausted, cursor: state }
    }
    // Seed step only — do the message work on the next step so this stays one
    // Whapi call.
    return { done: false, cursor: state }
  }

  // 2. Promote the next chat if we are between chats.
  if (!state.current) {
    const next = state.pending.shift()
    state.current = { id: next.id, name: next.name, msgOffset: 0 }
  }

  // 3. Pull one message page for the current chat.
  const list = await listMessages(env, state.current.id, {
    offset: state.current.msgOffset,
    count: STEP_MESSAGES,
    timeFrom: from,
    timeTo: to,
  })

  if (!list.ok) {
    // Skip this chat, record the failure, move on.
    const chatId = state.current.id
    state.current = null
    return {
      done: false,
      cursor: state,
      error: list.error,
      errorChat: chatId,
      addConversationsDone: 0,
    }
  }

  logRawPage(state.current.id, state.current.msgOffset, list.messages)
  const { added, mediaFailed } = await ingestBatch(env, db, list.messages, state.current.name, windowSec, state.current.id)

  state.current.msgOffset += list.messages.length
  const chatDone = list.messages.length < STEP_MESSAGES
  let conversationsDone = 0
  if (chatDone) {
    conversationsDone = 1
    state.current = null
  }

  // The whole job is done only once there is no current chat, nothing pending,
  // and /chats has been exhausted.
  const done = !state.current && state.pending.length === 0 && state.chatsExhausted

  return {
    done,
    cursor: state,
    addAdded: added,
    addMediaFailed: mediaFailed,
    addConversationsDone: conversationsDone,
  }
}
