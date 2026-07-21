import { getDb, unwrap, UNIQUE_VIOLATION } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { sendText, toDigits } from '../../_lib/whapi.js'
import { MESSAGE_COLUMNS } from '../../_lib/storage.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

/**
 * POST /api/conversations/new
 * Body: { phone, name?, message }
 *
 * Starts a conversation with a number that has not written in yet.
 *
 * The number is normalised with the SAME toDigits() the inbound webhook uses,
 * which is what makes a manually started conversation and a later inbound
 * message from that number resolve to one row instead of two. customer_number
 * is UNIQUE, so the find-or-create below is the only writer of that column
 * besides the webhook.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { phone, name, message } = await readJson(request)

  const customerNumber = toDigits(phone)
  // E.164 allows 8–15 digits; anything outside that is a typo, not a number.
  if (!customerNumber || customerNumber.length < 8 || customerNumber.length > 15) {
    return badRequest('Enter a valid phone number in international format')
  }
  if (typeof message !== 'string' || !message.trim()) {
    return badRequest('A message is required')
  }

  const text = message.trim()
  const customerName = typeof name === 'string' && name.trim() ? name.trim() : null

  try {
    const db = getDb(env)
    const now = new Date().toISOString()
    const businessNumber = toDigits(env.BUSINESS_NUMBER)

    // --- find or create, keyed on the normalised digits ---
    let conversation = unwrap(
      await db
        .from('wp_chat_conversations')
        .select('id, customer_number, business_number, customer_name, assigned_user_id')
        .eq('customer_number', customerNumber)
        .maybeSingle()
    )

    let createdConversation = false

    if (!conversation) {
      const created = await db
        .from('wp_chat_conversations')
        .insert({
          customer_number: customerNumber,
          business_number: businessNumber,
          customer_name: customerName,
          unread_count: 0,
          status: 'open',
          created_at: now,
          updated_at: now,
        })
        .select('id, customer_number, business_number, customer_name, assigned_user_id')
        .single()

      if (created.error) {
        // The webhook raced us for this number — take its row.
        if (created.error.code === UNIQUE_VIOLATION) {
          conversation = unwrap(
            await db
              .from('wp_chat_conversations')
              .select('id, customer_number, business_number, customer_name, assigned_user_id')
              .eq('customer_number', customerNumber)
              .maybeSingle()
          )
        }
        if (!conversation) throw new Error(created.error.message)
      } else {
        conversation = created.data
        createdConversation = true
      }
    } else if (customerName && !String(conversation.customer_name || '').trim()) {
      // Fill a blank name, never overwrite one a human may have corrected.
      unwrap(
        await db
          .from('wp_chat_conversations')
          .update({ customer_name: customerName })
          .eq('id', conversation.id)
      )
      conversation.customer_name = customerName
    }

    // --- send BEFORE persisting the message row ---
    // WhatsApp restricts messaging numbers that have not written in recently,
    // so this is the step most likely to fail. Sending first means a rejection
    // leaves no orphaned conversation and no phantom message in the thread.
    const result = await sendText(env, customerNumber, text)

    if (!result.ok) {
      // Roll back a conversation we created solely for this attempt. An
      // existing one is left alone — it has history that is not ours to drop.
      if (createdConversation) {
        await db.from('wp_chat_conversations').delete().eq('id', conversation.id)
      }
      return json(
        {
          ok: false,
          error:
            'WhatsApp would not accept a message to that number. It may not allow messages from businesses it has not contacted recently.',
          detail: result.error || null,
        },
        502
      )
    }

    const sentMessage = unwrap(
      await db
        .from('wp_chat_messages')
        .insert({
          conversation_id: conversation.id,
          direction: 'outbound',
          from_number: businessNumber || conversation.business_number,
          to_number: customerNumber,
          body: text,
          status: 'sent',
          is_read: true,
          sent_by: auth.user.name,
          created_at: now,
          ...(result.messageId ? { whapi_message_id: result.messageId } : {}),
        })
        .select(MESSAGE_COLUMNS)
        .single()
    )

    unwrap(
      await db
        .from('wp_chat_conversations')
        .update({
          last_message_body: text,
          last_message_at: now,
          last_direction: 'outbound',
          updated_at: now,
        })
        .eq('id', conversation.id)
    )

    return json({
      ok: true,
      conversation_id: conversation.id,
      created: createdConversation,
      message: sentMessage,
    })
  } catch (err) {
    return serverError(err.message || 'Could not start the conversation')
  }
}
