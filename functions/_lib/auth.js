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
 * Loads a conversation any authenticated user may access.
 *
 * Assignment is NO LONGER a permission boundary — every agent sees, reads and
 * replies to every conversation, assigned or not; `assigned_user_id` is kept
 * only as a "who is handling this" label. This used to 403 an agent on a
 * conversation not assigned to them; that check has been removed. The only
 * failure now is a conversation that does not exist (404).
 *
 * `user` is still accepted so every caller keeps a stable signature and so the
 * gate can be re-tightened in one place if that ever changes.
 */
export async function requireConversationAccess(env, user, conversationId) {
  const conversation = unwrap(
    await getDb(env)
      .from('wp_chat_conversations')
      .select('id, customer_number, business_number, customer_name, assigned_user_id, avatar_path, avatar_error, is_group, group_jid, member_count')
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

  return { conversation }
}

function unauth() {
  return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}
