import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth } from '../_lib/auth.js'
import { json, serverError } from '../_lib/respond.js'

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  try {
    // password_hash is never selected here.
    const users =
      unwrap(
        await getDb(env)
          .from('wp_chat_users')
          .select('id, name, email, role, is_active, created_at')
          .order('is_active', { ascending: false })
      ) || []

    // PostgREST can't order by lower(name), so sort the (small) roster here to
    // keep the case-insensitive ordering the SQL version had.
    users.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        sensitivity: 'base',
      })
    })

    return json({ ok: true, users })
  } catch (err) {
    return serverError(err.message || 'Failed to load users')
  }
}
