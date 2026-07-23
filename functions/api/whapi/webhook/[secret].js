import { getDb, unwrap, UNIQUE_VIOLATION } from '../../../_lib/db.js'
import { redactPayload } from '../../../_lib/whapi.js'
import {
  shapeInboundMessage,
  ingestAttachment,
  findOrCreateGroup,
  findOrCreateConversation,
  previewLine,
} from '../../../_lib/ingest.js'
import { notifyNewMessage } from '../../../_lib/notify.js'
import { ingestAvatar } from '../../../_lib/avatar.js'
import { syncGroup } from '../../../_lib/group.js'

// Public endpoint — called by Whapi, not by a logged-in user. Whapi supports
// neither signed webhooks nor custom auth headers, so the secret path segment
// IS the credential. A wrong secret gets a 404 so the route's existence stays
// unadvertised.
//
//   https://<domain>/api/whapi/webhook/<WHAPI_WEBHOOK_SECRET>

const notFound = () =>
  new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })

const accepted = (detail) =>
  new Response(JSON.stringify({ ok: true, ...detail }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/** Length-independent constant-time compare, so the secret can't be timed out. */
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  if (!expected) return false

  const a = new TextEncoder().encode(provided)
  const b = new TextEncoder().encode(expected)

  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

export async function onRequest(context) {
  const { request, env, params } = context
  // Collected during processing and flushed after the response — Whapi must
  // get its 200 without waiting on push delivery.
  const pending = []

  if (!secretsMatch(params?.secret, env?.WHAPI_WEBHOOK_SECRET)) return notFound()
  // Hide the route from anything that isn't the real delivery.
  if (request.method !== 'POST') return notFound()

  let payload
  try {
    payload = await request.json()
  } catch {
    // Malformed body: 200 anyway, or Whapi retries it forever.
    console.error('whapi webhook: body was not valid JSON')
    return accepted({ processed: 0, skipped: 0 })
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  let processed = 0
  let skipped = 0

  for (const msg of messages) {
    try {
      const result = await handleMessage(env, msg, pending)
      if (result === 'inserted') processed++
      else skipped++
    } catch (err) {
      // One bad message must not sink the batch, and must not trigger a retry
      // of the messages that already landed.
      skipped++
      console.error('whapi webhook: failed to process message', msg?.id, err?.message)
    }
  }

  // Fire-and-forget: the runtime keeps the isolate alive for these after the
  // response has already gone back to Whapi.
  if (pending.length) {
    const flush = Promise.all(pending).catch(() => {})
    if (typeof context.waitUntil === 'function') context.waitUntil(flush)
  }

  return accepted({ processed, skipped })
}

async function handleMessage(env, msg, pending = []) {
  // Shared with the sync backfill — see functions/_lib/ingest.js. Everything
  // from here down is the LIVE-only behaviour: unread bump and push fan-out.
  const shaped = shapeInboundMessage(msg, env)
  if (shaped.skip) {
    if (shaped.skip === 'broadcast' || shaped.skip === 'over_long_id') {
      console.log(
        'whapi webhook: skipping message',
        JSON.stringify({ skip: shaped.skip, message_id: msg?.id ?? null, payload: redactPayload(msg) })
      )
    }
    return 'skipped'
  }

  const {
    groupJid, sender, customerNumber, customerName,
    whapiMessageId, body, createdAt, explicitMedia, attachment, businessNumber,
  } = shaped

  const db = getDb(env)

  const conversation = groupJid
    ? await findOrCreateGroup(db, groupJid, businessNumber, msg?.chat_name)
    : await findOrCreateConversation(db, customerNumber, businessNumber, customerName)

  // On creation only — no refresh, no backfill. Fire-and-forget via the same
  // waitUntil the push fan-out uses, so it can never delay the 200.
  if (conversation.__created) {
    pending.push(
      groupJid
        ? syncGroup(env, conversation.id, groupJid)
        : ingestAvatar(env, conversation.id, customerNumber)
    )
  }

  // Pull the bytes into our own bucket. A failure here must degrade to a
  // "Media unavailable" bubble, never drop the message.
  let media = explicitMedia
  let mediaError = null

  if (attachment) {
    const ingested = await ingestAttachment(env, conversation.id, attachment)
    media = ingested.media
    mediaError = ingested.error
  }

  // Insert the message. whapi_message_id is UNIQUE, which is what makes a Whapi
  // retry idempotent — the duplicate is dropped and the badge is not re-bumped.
  const inserted = await db
    .from('wp_chat_messages')
    .insert({
      conversation_id: conversation.id,
      direction: 'inbound',
      from_number: groupJid ? sender.number : customerNumber,
      to_number: businessNumber,
      // Null for 1:1 — the conversation already identifies the other party.
      sender_number: groupJid ? sender.number : null,
      sender_name: groupJid ? sender.name : null,
      body,
      whapi_message_id: whapiMessageId,
      status: 'received',
      is_read: false,
      created_at: createdAt,
      // media_error flags the failure to the UI; error_code carries the reason.
      ...(mediaError ? { error_code: mediaError.slice(0, 200) } : {}),
      ...(media ? { ...media, media_caption: body } : {}),
    })
    .select('id')
    .single()

  if (inserted.error) {
    if (inserted.error.code === UNIQUE_VIOLATION) return 'skipped'
    throw new Error(inserted.error.message)
  }

  // Preview + unread badge, only for a message we actually stored.
  //
  // PostgREST has no atomic `unread_count = unread_count + 1`, so this is a
  // read-modify-write. Two messages arriving in the same instant can lose a
  // count; the badge is a hint and opening the thread resets it, so that is an
  // acceptable trade for not adding a DB function.
  const current = unwrap(
    await db
      .from('wp_chat_conversations')
      .select('unread_count')
      .eq('id', conversation.id)
      .maybeSingle()
  )

  unwrap(
    await db
      .from('wp_chat_conversations')
      .update({
        // Media with no caption still needs a readable preview line. In a
        // group the sender is prefixed here rather than in a separate column —
        // it is what the list AND the toast both want to show.
        last_message_body: previewLine(groupJid, sender, body, media),
        last_message_at: createdAt,
        last_direction: 'inbound',
        unread_count: (Number(current?.unread_count) || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)
  )

  // Only genuine inbound messages reach here — from_me echoes and duplicates
  // returned earlier, so no push is ever sent for our own replies.
  pending.push(
    notifyNewMessage(env, {
      conversation: { id: conversation.id, assigned_user_id: conversation.assigned_user_id },
      message: { id: inserted.data?.id ?? null, body, media_type: media?.media_type ?? null },
      title: groupJid
        ? conversation.customer_name || 'Group'
        : customerName || conversation.customer_name || `+${customerNumber}`,
      // Prefixes the body with the sender inside a group, as WhatsApp does.
      senderName: groupJid ? sender.name || (sender.number ? `+${sender.number}` : null) : null,
    })
  )

  return 'inserted'
}
