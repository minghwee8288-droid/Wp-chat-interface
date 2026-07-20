import { query, queryOne } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { hashPassword, verifyPassword } from '../../_lib/hash.js'
import { json, badRequest, serverError, readJson } from '../../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { current_password, new_password } = await readJson(request)

  if (typeof current_password !== 'string' || !current_password) {
    return badRequest('Current password is required')
  }
  if (typeof new_password !== 'string' || new_password.length < 8) {
    return badRequest('New password must be at least 8 characters')
  }

  try {
    const row = await queryOne(
      env,
      `select password_hash from wp_chat_users where id = $1`,
      [auth.user.id]
    )
    if (!row || !(await verifyPassword(current_password, row.password_hash))) {
      return badRequest('Current password is incorrect')
    }

    await query(env, `update wp_chat_users set password_hash = $1 where id = $2`, [
      await hashPassword(new_password),
      auth.user.id,
    ])

    return json({ ok: true })
  } catch (err) {
    return serverError(err.message || 'Failed to change password')
  }
}
