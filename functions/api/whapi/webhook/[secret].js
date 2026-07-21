import { getDb, unwrap, UNIQUE_VIOLATION } from '../../../_lib/db.js'
import {
  toDigits,
  fetchMedia,
  groupJidOf,
  senderOf,
  redactPayload,
} from '../../../_lib/whapi.js'
import {
  readMediaFields,
  uploadObject,
  mediaTypeFromWhapi,
  MAX_UPLOAD_BYTES,
} from '../../../_lib/storage.js'
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
  // Echoes of our own outbound messages — /api/send already wrote those rows.
  // Without this every team reply would be duplicated.
  if (msg?.from_me === true) return 'skipped'

  // Groups are supported. The JID is resolved with the SAME field sweep the
  // old skip used, so every message from one group lands in ONE conversation
  // no matter which participant sent it — that was the regression, and the
  // sender is now recorded per message instead of keying the conversation.
  const groupJid = groupJidOf(msg)
  const sender = groupJid ? senderOf(msg) : { number: null, name: null }

  // Broadcasts and newsletters are still not conversations.
  const chatIdRaw = String(msg?.chat_id ?? '')
  if (/@(broadcast|newsletter)$/i.test(chatIdRaw)) {
    console.log(
      'whapi webhook: skipping broadcast/newsletter',
      JSON.stringify({ skip: 'broadcast', message_id: msg?.id ?? null, payload: redactPayload(msg) })
    )
    return 'skipped'
  }

  // Media may arrive pre-ingested (explicit media_* fields) or as a native
  // Whapi attachment we have to download ourselves.
  const explicitMedia = readMediaFields(msg)
  const attachment = explicitMedia ? null : describeAttachment(msg)

  // Text-only messages still require type 'text'.
  if (!explicitMedia && !attachment && msg?.type !== 'text') return 'skipped'

  // 1:1 only. For a group the conversation is keyed on the JID instead, and
  // this stays null.
  const customerNumber = groupJid ? null : toDigits(msg?.chat_id ?? msg?.from)
  const whapiMessageId = msg?.id ? String(msg.id) : null

  // Caption may arrive as text.body, caption, media_caption, or on the
  // attachment object itself.
  const rawBody =
    msg?.text?.body ?? msg?.caption ?? attachment?.caption ?? explicitMedia?.media_caption ?? null
  const body = typeof rawBody === 'string' && rawBody ? rawBody : null

  if (!groupJid && !customerNumber) return 'skipped'
  // Belt and braces on the 1:1 path: nothing over the E.164 maximum is a real
  // phone number, so an unrecognised group id still cannot become a contact.
  if (customerNumber && customerNumber.length > 15) {
    console.error(
      'whapi webhook: refusing an over-long identifier',
      JSON.stringify({ skip: 'group_chat', digits: customerNumber.length, payload: redactPayload(msg) })
    )
    return 'skipped'
  }
  // Without media, a body is mandatory — otherwise there is nothing to show.
  if (!explicitMedia && !attachment && !body) return 'skipped'

  const fromName = typeof msg?.from_name === 'string' ? msg.from_name.trim() : ''
  const customerName = fromName || null

  // Whapi sends UNIX seconds.
  const timestamp = Number(msg?.timestamp)
  const createdAt = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : new Date().toISOString()

  const db = getDb(env)
  const businessNumber = toDigits(env.BUSINESS_NUMBER)

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
        last_message_body: groupJid
          ? `${sender.name || (sender.number ? `+${sender.number}` : 'Someone')}: ${
              body || mediaPreviewLabel(media)
            }`
          : body || mediaPreviewLabel(media),
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

const ATTACHMENT_KEYS = ['image', 'video', 'audio', 'voice', 'ptt', 'document', 'sticker', 'gif']

/**
 * Pull a native Whapi attachment descriptor off an inbound message.
 * Whapi nests it under a key matching the message type, e.g.
 *   { type: 'image', image: { id, mime_type, file_size, caption } }
 * Returns null when the message carries no attachment.
 */
function describeAttachment(msg) {
  const key = ATTACHMENT_KEYS.includes(msg?.type) ? msg.type : null
  const info = (key && msg[key]) || msg?.media || null
  if (!info || typeof info !== 'object') return null

  const mediaId = info.id || info.media_id || null
  // No id means nothing to download — treat as no attachment at all.
  if (!mediaId) return null

  const mime = String(info.mime_type || info.mime || '').split(';')[0].trim() || null
  const size = Number(info.file_size ?? info.size)

  return {
    mediaId: String(mediaId),
    mime,
    filename: info.file_name || info.filename || null,
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : null,
    caption: typeof info.caption === 'string' && info.caption ? info.caption : null,
    type: mediaTypeFromWhapi(msg?.type, mime),
  }
}

/**
 * Download from Whapi and store in our bucket.
 * Always returns a media object so the row records what the attachment WAS,
 * even when the bytes could not be retrieved — media_path stays null and the
 * caller records the reason. Never throws.
 */
async function ingestAttachment(env, conversationId, attachment) {
  const base = {
    media_path: null,
    media_type: attachment.type,
    media_mime: attachment.mime,
    media_filename: attachment.filename,
    media_size: attachment.size,
    media_caption: null,
    media_error: true,
  }

  const fetched = await fetchMedia(env, attachment.mediaId, MAX_UPLOAD_BYTES)
  if (!fetched.ok) {
    console.error('whapi webhook: media fetch failed', attachment.mediaId, fetched.error)
    return { media: base, error: fetched.error }
  }

  const mime = attachment.mime || fetched.mime || 'application/octet-stream'

  const uploaded = await uploadObject(env, {
    conversationId,
    bytes: fetched.bytes,
    mime,
    filename: attachment.filename,
  })

  if (!uploaded.ok) {
    console.error('whapi webhook: media upload failed', attachment.mediaId, uploaded.error)
    return { media: { ...base, media_mime: mime }, error: uploaded.error }
  }

  return {
    media: {
      ...base,
      media_path: uploaded.path,
      media_mime: mime,
      media_size: attachment.size ?? fetched.bytes.byteLength,
      media_error: false,
    },
    error: null,
  }
}

function mediaPreviewLabel(media) {
  if (!media) return null
  if (media.media_type === 'image') return '📷 Photo'
  if (media.media_type === 'video') return '🎥 Video'
  if (media.media_type === 'audio') return '🎵 Audio'
  return '📄 Document'
}

/**
 * Find-or-create by group JID.
 *
 * group_jid is UNIQUE, which is what guarantees one conversation per group
 * regardless of how many participants write in.
 */
async function findOrCreateGroup(db, groupJid, businessNumber, chatName) {
  const existing = unwrap(
    await db
      .from('wp_chat_conversations')
      .select('id, customer_name, assigned_user_id')
      .eq('group_jid', groupJid)
      .maybeSingle()
  )
  if (existing) return existing

  const subject = typeof chatName === 'string' && chatName.trim() ? chatName.trim() : null

  const created = await db
    .from('wp_chat_conversations')
    .insert({
      is_group: true,
      group_jid: groupJid,
      customer_number: null,
      business_number: businessNumber,
      // The webhook often carries chat_name; syncGroup fills it if not.
      customer_name: subject,
      unread_count: 0,
      status: 'open',
    })
    .select('id, customer_name, assigned_user_id')
    .single()

  if (created.error) {
    // Two participants wrote at once — take whichever row landed first.
    if (created.error.code === UNIQUE_VIOLATION) {
      const row = unwrap(
        await db
          .from('wp_chat_conversations')
          .select('id, customer_name, assigned_user_id')
          .eq('group_jid', groupJid)
          .maybeSingle()
      )
      if (row) return row
    }
    throw new Error(created.error.message)
  }
  return { ...created.data, __created: true }
}

/**
 * Find-or-create by customer_number.
 *
 * The DB also has wp_chat_upsert_conversation_named(...) which could be called
 * via .rpc(), but doing it explicitly here keeps this independent of that
 * function's exact parameter names.
 */
async function findOrCreateConversation(db, customerNumber, businessNumber, customerName) {
  const existing = unwrap(
    await db
      .from('wp_chat_conversations')
      .select('id, customer_name, assigned_user_id')
      .eq('customer_number', customerNumber)
      .maybeSingle()
  )

  if (existing) {
    // Only fill a blank name. A human may have corrected it — never clobber that
    // with the WhatsApp profile name.
    if (customerName && !String(existing.customer_name || '').trim()) {
      unwrap(
        await db
          .from('wp_chat_conversations')
          .update({ customer_name: customerName })
          .eq('id', existing.id)
      )
    }
    return existing
  }

  const created = await db
    .from('wp_chat_conversations')
    .insert({
      customer_number: customerNumber,
      business_number: businessNumber,
      customer_name: customerName,
      unread_count: 0,
      status: 'open',
    })
    .select('id, customer_name, assigned_user_id')
    .single()

  if (created.error) {
    // customer_number is UNIQUE: another delivery for a brand-new number raced
    // us. Re-read and use theirs — and do NOT claim creation, or both racers
    // would fetch the same avatar.
    if (created.error.code === UNIQUE_VIOLATION) {
      const row = unwrap(
        await db
          .from('wp_chat_conversations')
          .select('id, customer_name, assigned_user_id')
          .eq('customer_number', customerNumber)
          .maybeSingle()
      )
      if (row) return row
    }
    throw new Error(created.error.message)
  }

  return { ...created.data, __created: true }
}
