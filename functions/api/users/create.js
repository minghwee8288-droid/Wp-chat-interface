import { queryOne } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { hashPassword } from '../../_lib/hash.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const { name, email, password, role } = await readJson(request)

  if (typeof name !== 'string' || !name.trim()) return badRequest('Name is required')
  if (typeof email !== 'string' || !email.includes('@')) {
    return badRequest('A valid email is required')
  }
  if (typeof password !== 'string' || password.length < 8) {
    return badRequest('Password must be at least 8 characters')
  }
  const userRole = role === 'admin' ? 'admin' : 'agent'

  try {
    const existing = await queryOne(
      env,
      `select id from wp_chat_users where lower(email) = lower($1)`,
      [email.trim()]
    )
    if (existing) return badRequest('A user with that email already exists')

    const passwordHash = await hashPassword(password)

    const user = await queryOne(
      env,
      `insert into wp_chat_users (name, email, password_hash, role, is_active, created_at)
       values ($1, $2, $3, $4, true, now())
       returning id, name, email, role, is_active, created_at`,
      [name.trim(), email.trim().toLowerCase(), passwordHash, userRole]
    )

    return json({ ok: true, user })
  } catch (err) {
    // Belt and braces: the UNIQUE index can still fire on a concurrent insert.
    if (String(err.message || '').includes('duplicate key')) {
      return badRequest('A user with that email already exists')
    }
    return serverError(err.message || 'Failed to create user')
  }
}
