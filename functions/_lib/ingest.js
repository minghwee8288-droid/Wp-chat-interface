// Shared inbound-message ingestion.
//
// Extracted from the Whapi webhook so the SYNC backfill goes through exactly
// the same media-fetch, group-routing and dedup pipeline as live delivery.
// The webhook and the sync worker both call shapeInboundMessage() to normalise
// a raw Whapi message, then findOrCreate*/ingestAttachment to land it — they
// differ only in the side effects AFTER the insert (unread + push for live,
// nothing for historical).

import { unwrap, UNIQUE_VIOLATION } from './db.js'
import { toDigits, fetchMedia, groupJidOf, senderOf } from './whapi.js'
import {
  readMediaFields,
  uploadObject,
  mediaTypeFromWhapi,
  MAX_UPLOAD_BYTES,
} from './storage.js'

const ATTACHMENT_KEYS = ['image', 'video', 'audio', 'voice', 'ptt', 'document', 'sticker', 'gif']

/** E.164 caps a real phone number at 15 digits; longer means a group id. */
const MAX_E164_DIGITS = 15

/**
 * Pull a native Whapi attachment descriptor off an inbound message.
 * Whapi nests it under a key matching the message type, e.g.
 *   { type: 'image', image: { id, mime_type, file_size, caption } }
 * Returns null when the message carries no attachment.
 */
export function describeAttachment(msg) {
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
 *
 * For a historical sync this is also where an EXPIRED media id surfaces: Whapi
 * answers 404/410, fetchMedia returns {ok:false}, and this degrades to
 * media_error just like a live failure — never an exception.
 */
export async function ingestAttachment(env, conversationId, attachment) {
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
    console.error('ingest: media fetch failed', attachment.mediaId, fetched.error)
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
    console.error('ingest: media upload failed', attachment.mediaId, uploaded.error)
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

export function mediaPreviewLabel(media) {
  if (!media) return null
  if (media.media_type === 'image') return '📷 Photo'
  if (media.media_type === 'video') return '🎥 Video'
  if (media.media_type === 'audio') return '🎵 Audio'
  return '📄 Document'
}

/** Build the group-aware preview line used by the list AND the toast. */
export function previewLine(groupJid, sender, body, media) {
  const text = body || mediaPreviewLabel(media)
  if (!groupJid) return text
  const who = sender?.name || (sender?.number ? `+${sender.number}` : 'Someone')
  return `${who}: ${text}`
}

/**
 * Normalise a raw Whapi message (webhook OR /messages/list — same shape) into
 * the fields every downstream write needs, or {skip: reason} for anything that
 * is not a storable conversation message.
 *
 * `allowOutbound` is the ONE difference between live and historical handling:
 *   - LIVE webhook (default false): a from_me message is an echo of a reply we
 *     already wrote in /api/send, so it is skipped. This must never change.
 *   - SYNC (true): nothing has been written yet, so a from_me message is a real
 *     outbound record to keep — shaped with `fromMe: true` so the caller writes
 *     it with direction 'outbound'.
 *
 * Pure: no I/O, no side effects — which is what lets both callers share it and
 * what makes it unit-testable without a database.
 */
export function shapeInboundMessage(msg, env, { allowOutbound = false } = {}) {
  const fromMe = msg?.from_me === true
  // Live: drop our own outbound echoes. Sync: keep them (see above).
  if (fromMe && !allowOutbound) return { skip: 'from_me' }

  const groupJid = groupJidOf(msg)
  // Outbound has no inbound "sender" — `from` is us, so senderOf would wrongly
  // treat the business number as a group participant. Only inbound resolves one.
  const sender = groupJid && !fromMe ? senderOf(msg) : { number: null, name: null }

  // Broadcasts and newsletters are never conversations.
  const chatIdRaw = String(msg?.chat_id ?? '')
  if (/@(broadcast|newsletter)$/i.test(chatIdRaw)) return { skip: 'broadcast' }

  const explicitMedia = readMediaFields(msg)
  const attachment = explicitMedia ? null : describeAttachment(msg)

  // Text-only messages must be type 'text'.
  if (!explicitMedia && !attachment && msg?.type !== 'text') return { skip: 'non_text' }

  const customerNumber = groupJid ? null : toDigits(msg?.chat_id ?? msg?.from)
  const whapiMessageId = msg?.id ? String(msg.id) : null

  const rawBody =
    msg?.text?.body ?? msg?.caption ?? attachment?.caption ?? explicitMedia?.media_caption ?? null
  const body = typeof rawBody === 'string' && rawBody ? rawBody : null

  if (!groupJid && !customerNumber) return { skip: 'no_identifier' }
  // Belt and braces: nothing over the E.164 maximum is a real phone number, so
  // an unrecognised group id still cannot become a 1:1 contact.
  if (customerNumber && customerNumber.length > MAX_E164_DIGITS) return { skip: 'over_long_id' }
  // Without media, a body is mandatory — otherwise there is nothing to show.
  if (!explicitMedia && !attachment && !body) return { skip: 'empty' }

  const fromName = typeof msg?.from_name === 'string' ? msg.from_name.trim() : ''

  // Whapi sends UNIX seconds.
  const ts = Number(msg?.timestamp)
  const createdAt =
    Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString()

  return {
    skip: null,
    fromMe,
    groupJid,
    sender,
    customerNumber,
    customerName: fromName || null,
    whapiMessageId,
    body,
    createdAt,
    explicitMedia,
    attachment,
    businessNumber: toDigits(env?.BUSINESS_NUMBER),
  }
}

/**
 * Find-or-create by group JID.
 * group_jid is UNIQUE, so one conversation per group no matter how many
 * participants write in. Returns the row; a freshly created one carries
 * __created so the caller can kick off the one-time group sync.
 */
export async function findOrCreateGroup(db, groupJid, businessNumber, chatName) {
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
 * Find-or-create by customer_number. Fills a blank name only — never clobbers a
 * name a human may have corrected.
 */
export async function findOrCreateConversation(db, customerNumber, businessNumber, customerName) {
  const existing = unwrap(
    await db
      .from('wp_chat_conversations')
      .select('id, customer_name, assigned_user_id')
      .eq('customer_number', customerNumber)
      .maybeSingle()
  )

  if (existing) {
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
