import { query } from '../_lib/db.js'
import { requireAuth } from '../_lib/auth.js'
import { json, serverError } from '../_lib/respond.js'

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  try {
    // password_hash is never selected here.
    const users = await query(
      env,
      `select id, name, email, role, is_active, created_at
         from wp_chat_users
        order by is_active desc, lower(name) asc`
    )
    return json({ ok: true, users })
  } catch (err) {
    return serverError(err.message || 'Failed to load users')
  }
}
