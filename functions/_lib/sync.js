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
import { listMessages, listChats } from './whapi.js'
import {
  shapeInboundMessage,
  ingestAttachment,
  findOrCreateGroup,
  findOrCreateConversation,
  previewLine,
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
 * Store one historical message. Returns
 *   { added, duplicate, skipped, mediaFailed, error }
 * and never throws for an expired attachment — that degrades to media_error
 * exactly as a live failure does.
 */
export async function persistHistorical(env, db, msg, chatName) {
  const shaped = shapeInboundMessage(msg, env)
  if (shaped.skip) return { added: false, skipped: true }

  const {
    groupJid, sender, customerNumber, customerName,
    whapiMessageId, body, createdAt, explicitMedia, attachment, businessNumber,
  } = shaped

  const conversation = groupJid
    ? await findOrCreateGroup(db, groupJid, businessNumber, chatName)
    : await findOrCreateConversation(db, customerNumber, businessNumber, customerName)

  // Same fetch-and-store pipeline as live inbound. An expired media id comes
  // back as media_error rather than throwing.
  let media = explicitMedia
  let mediaError = null
  if (attachment) {
    const ingested = await ingestAttachment(env, conversation.id, attachment)
    media = ingested.media
    mediaError = ingested.error
  }

  const inserted = await db
    .from('wp_chat_messages')
    .insert({
      conversation_id: conversation.id,
      direction: 'inbound',
      from_number: groupJid ? sender.number : customerNumber,
      to_number: businessNumber,
      sender_number: groupJid ? sender.number : null,
      sender_name: groupJid ? sender.name : null,
      body,
      whapi_message_id: whapiMessageId,
      status: 'received',
      // Historical messages are considered already-read: a backfill must not
      // inflate unread counts.
      is_read: true,
      created_at: createdAt,
      ...(mediaError ? { error_code: mediaError.slice(0, 200) } : {}),
      ...(media ? { ...media, media_caption: body } : {}),
    })
    .select('id')
    .single()

  if (inserted.error) {
    // Already synced (or delivered live): the unique whapi_message_id makes
    // this a no-op, which is exactly the dedup guarantee.
    if (inserted.error.code === UNIQUE_VIOLATION) return { added: false, duplicate: true }
    throw new Error(inserted.error.message)
  }

  // Preview/order guard: only move last_message_at FORWARD. A three-month-old
  // message must never jump a conversation to the top or clobber a newer
  // preview. Unread is intentionally left untouched.
  const conv = unwrap(
    await db.from('wp_chat_conversations').select('last_message_at').eq('id', conversation.id).maybeSingle()
  )
  const existingAt = conv?.last_message_at ? new Date(conv.last_message_at).getTime() : 0
  if (new Date(createdAt).getTime() > existingAt) {
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          last_message_body: previewLine(groupJid, sender, body, media),
          last_message_at: createdAt,
          last_direction: 'inbound',
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation.id)
    )
  }

  return { added: true, mediaFailed: Boolean(mediaError) }
}

/** Process a batch of raw messages, honouring an optional time window. */
async function ingestBatch(env, db, messages, chatName, windowSec) {
  let added = 0
  let mediaFailed = 0

  for (const msg of messages) {
    // Defensive window filter: even if Whapi ignores time_from/time_to, an
    // out-of-range message is skipped so a range sync stays within its dates.
    if (windowSec) {
      const ts = Number(msg?.timestamp)
      if (Number.isFinite(ts)) {
        if (windowSec.from && ts < windowSec.from) continue
        if (windowSec.to && ts > windowSec.to) continue
      }
    }
    const r = await persistHistorical(env, db, msg, chatName)
    if (r.added) added++
    if (r.mediaFailed) mediaFailed++
  }

  return { added, mediaFailed }
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

  const { added, mediaFailed } = await ingestBatch(env, db, list.messages, scope.name, null)
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

  const { added, mediaFailed } = await ingestBatch(env, db, list.messages, state.current.name, windowSec)

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
