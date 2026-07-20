import { getDb, unwrap } from './db.js'
import { sendPush } from './push.js'

const MAX_FAILURES = 5
const PREVIEW_LIMIT = 140

/** Notification body for a message, falling back to a media label. */
export function previewFor(message) {
  const text = (message?.body || message?.media_caption || '').trim()
  if (text) return text.slice(0, PREVIEW_LIMIT)

  switch (message?.media_type) {
    case 'image':
      return '📷 Photo'
    case 'video':
      return '🎥 Video'
    case 'audio':
      return '🎵 Audio'
    case 'document':
      return '📄 Document'
    default:
      return 'New message'
  }
}

/**
 * Who should hear about this conversation.
 *
 * Assigned → that agent alone. Unassigned → every active user, admins
 * included: an unassigned conversation sits in everyone's inbox, so limiting
 * it to role='agent' would leave admins unaware of unclaimed messages.
 */
async function recipientIds(env, conversation) {
  const db = getDb(env)

  if (conversation?.assigned_user_id) {
    const user = unwrap(
      await db
        .from('wp_chat_users')
        .select('id')
        .eq('id', conversation.assigned_user_id)
        .eq('is_active', true)
        .maybeSingle()
    )
    return user ? [user.id] : []
  }

  const users =
    unwrap(await db.from('wp_chat_users').select('id').eq('is_active', true)) || []
  return users.map((u) => u.id)
}

/** Records the outcome of one delivery, pruning subscriptions that are dead. */
async function recordOutcome(db, subscription, result) {
  if (result.ok) {
    await db
      .from('wp_chat_push_subscriptions')
      .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
      .eq('id', subscription.id)
    return
  }

  // 404/410 mean the browser threw the subscription away — remove it now
  // rather than retrying a dead endpoint forever.
  if (result.gone) {
    await db.from('wp_chat_push_subscriptions').delete().eq('id', subscription.id)
    return
  }

  const failures = (Number(subscription.failure_count) || 0) + 1
  if (failures >= MAX_FAILURES) {
    await db.from('wp_chat_push_subscriptions').delete().eq('id', subscription.id)
    return
  }

  await db
    .from('wp_chat_push_subscriptions')
    .update({ failure_count: failures })
    .eq('id', subscription.id)
}

/**
 * Fan out one inbound message to every relevant subscription.
 *
 * Never throws — the caller hands this to waitUntil, so a failure here must
 * not affect the webhook's response.
 */
export async function notifyNewMessage(env, { conversation, message, title }) {
  try {
    const db = getDb(env)

    const userIds = await recipientIds(env, conversation)
    if (!userIds.length) return { sent: 0 }

    const subscriptions =
      unwrap(
        await db
          .from('wp_chat_push_subscriptions')
          .select('id, user_id, endpoint, p256dh, auth, failure_count')
          .in('user_id', userIds)
      ) || []

    if (!subscriptions.length) return { sent: 0 }

    const payload = {
      title: title || 'New message',
      body: previewFor(message),
      conversation_id: conversation.id,
      message_id: message?.id ?? null,
    }

    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        const result = await sendPush(env, subscription, payload)
        await recordOutcome(db, subscription, result).catch(() => {})
        return result.ok
      })
    )

    return { sent: results.filter(Boolean).length, total: subscriptions.length }
  } catch (err) {
    console.error('push fan-out failed:', err?.message || err)
    return { sent: 0, error: String(err?.message || err) }
  }
}
