import { verifyJWT } from './jwt.js'
import { getDb, unwrap } from './db.js'

/**
 * Resolves the caller from the Authorization header.
 * Returns {user} on success or {response} holding the error to return.
 * The user row is re-read from the DB so a deactivated account loses access
 * immediately rather than at token expiry.
 */
export async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  const payload = await verifyJWT(token, env)
  if (!payload?.sub) {
    return { response: unauth() }
  }

  const user = unwrap(
    await getDb(env)
      .from('wp_chat_users')
      .select('id, name, email, role, is_active')
      .eq('id', payload.sub)
      .maybeSingle()
  )

  if (!user || !user.is_active) {
    return { response: unauth() }
  }

  return { user }
}

export async function requireAdmin(request, env) {
  const result = await requireAuth(request, env)
  if (result.response) return result
  if (result.user.role !== 'admin') {
    return {
      response: new Response(
        JSON.stringify({ ok: false, error: 'Admin access required' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    }
  }
  return result
}

/**
 * Agents may only touch conversations assigned to them. Returns the
 * conversation row, or {response} with a 403/404 to return instead.
 */
export async function requireConversationAccess(env, user, conversationId) {
  const conversation = unwrap(
    await getDb(env)
      .from('wp_chat_conversations')
      .select('id, customer_number, business_number, customer_name, assigned_user_id, avatar_path, avatar_error')
      .eq('id', conversationId)
      .maybeSingle()
  )

  if (!conversation) {
    return {
      response: new Response(
        JSON.stringify({ ok: false, error: 'Conversation not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      ),
    }
  }

  if (user.role !== 'admin' && String(conversation.assigned_user_id) !== String(user.id)) {
    return {
      response: new Response(
        JSON.stringify({ ok: false, error: 'This conversation is not assigned to you' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    }
  }

  return { conversation }
}

function unauth() {
  return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}
