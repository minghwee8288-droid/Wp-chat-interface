import { queryOne } from '../_lib/db.js'
import { verifyPassword } from '../_lib/hash.js'
import { signJWT } from '../_lib/jwt.js'
import { json, badRequest, unauthorized, serverError, readJson } from '../_lib/respond.js'

export async function onRequestPost({ request, env }) {
  try {
    const { email, password } = await readJson(request)

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return badRequest('Email and password are required')
    }

    const user = await queryOne(
      env,
      `select id, name, email, role, password_hash
         from wp_chat_users
        where lower(email) = lower($1) and is_active = true`,
      [email.trim()]
    )

    // Same message for unknown user and wrong password — don't leak which.
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return unauthorized('Invalid email or password')
    }

    const token = await signJWT(
      { sub: String(user.id), email: user.email, role: user.role, name: user.name },
      env
    )

    return json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    })
  } catch (err) {
    return serverError(err.message || 'Login failed')
  }
}
