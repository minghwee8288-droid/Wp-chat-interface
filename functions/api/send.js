import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { sendText, sendMedia, toDigits } from '../_lib/whapi.js'
import { readMediaFields, signUrl, MESSAGE_COLUMNS } from '../_lib/storage.js'
import { json, badRequest, serverError, readJson } from '../_lib/respond.js'

// Whapi fetches the media itself, so the URL has to outlive the request by a
// comfortable margin.
const OUTBOUND_MEDIA_TTL = 24 * 60 * 60

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const payload = await readJson(request)
  const { conversation_id, body } = payload

  const conversationId = Number(conversation_id)
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return badRequest('conversation_id is required')
  }

  const media = readMediaFields(payload)
  const text = typeof body === 'string' ? body.trim() : ''

  // body is nullable now — a message needs text, media, or both.
  if (!text && !media) {
    return badRequest('Message body or an attachment is required')
  }

  try {
    const access = await requireConversationAccess(env, auth.user, conversationId)
    if (access.response) return access.response
    const conversation = access.conversation

    const db = getDb(env)
    const now = new Date().toISOString()
    const businessNumber = toDigits(env.BUSINESS_NUMBER) || conversation.business_number

    // (1) Persist first, so a Whapi failure is visible rather than losing the message.
    const message = unwrap(
      await db
        .from('wp_chat_messages')
        .insert({
          conversation_id: conversationId,
          direction: 'outbound',
          from_number: businessNumber,
          to_number: conversation.customer_number,
          // With media, body carries the caption (or null).
          body: text || null,
          status: 'queued',
          is_read: true,
          sent_by: auth.user.name,
          created_at: now,
          // Outbound media is uploaded before this call, so it is never errored.
          ...(media ? { ...media, media_caption: text || null, media_error: false } : {}),
        })
        .select(MESSAGE_COLUMNS)
        .single()
    )

    // (2) Keep the list preview in sync. Media with no caption gets a label.
    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          last_message_body: text || mediaPreviewLabel(media),
          last_message_at: now,
          last_direction: 'outbound',
          updated_at: now,
        })
        .eq('id', conversationId)
    )

    // (3) Hand off to Whapi. Neither send call throws.
    let result
    if (media) {
      // Whapi pulls the bytes from this URL, so it must be reachable without
      // Supabase credentials — hence a signed URL rather than the object path.
      const signed = await signUrl(env, media.media_path, OUTBOUND_MEDIA_TTL)
      result = signed.ok
        ? await sendMedia(env, conversation.customer_number, {
            mediaUrl: signed.url,
            mediaType: media.media_type,
            caption: text || null,
            filename: media.media_filename,
            mime: media.media_mime,
          })
        : { ok: false, error: signed.error }
    } else {
      result = await sendText(env, conversation.customer_number, text)
    }

    if (result.ok) {
      const patch = { status: 'sent' }
      if (result.messageId) patch.whapi_message_id = result.messageId

      await db.from('wp_chat_messages').update(patch).eq('id', message.id)
      Object.assign(message, patch)
    } else {
      const code = String(result.error || 'send_failed').slice(0, 200)
      await db
        .from('wp_chat_messages')
        .update({ status: 'send_failed', error_code: code })
        .eq('id', message.id)
      message.status = 'send_failed'
      message.error_code = code
    }

    return json({ ok: true, message })
  } catch (err) {
    return serverError(err.message || 'Failed to send message')
  }
}

function mediaPreviewLabel(media) {
  if (!media) return null
  if (media.media_type === 'image') return '📷 Photo'
  if (media.media_type === 'video') return '🎥 Video'
  if (media.media_type === 'audio') return '🎵 Audio'
  return '📄 Document'
}
