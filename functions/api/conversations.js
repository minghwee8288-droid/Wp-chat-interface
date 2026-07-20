import { query } from '../_lib/db.js'
import { requireAuth } from '../_lib/auth.js'
import { json, serverError } from '../_lib/respond.js'

const SELECT = `
  select c.id,
         c.customer_number,
         c.business_number,
         c.customer_name,
         c.last_message_body,
         c.last_message_at,
         c.last_direction,
         c.unread_count,
         c.status,
         c.assigned_user_id,
         coalesce(u.name, c.assigned_to) as assigned_to,
         c.created_at,
         c.updated_at
    from wp_chat_conversations c
    left join wp_chat_users u on u.id = c.assigned_user_id
`

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  try {
    const isAdmin = auth.user.role === 'admin'

    const rows = isAdmin
      ? await query(env, `${SELECT} order by c.last_message_at desc nulls last`)
      : await query(
          env,
          `${SELECT} where c.assigned_user_id = $1 order by c.last_message_at desc nulls last`,
          [auth.user.id]
        )

    return json({ ok: true, conversations: rows })
  } catch (err) {
    return serverError(err.message || 'Failed to load conversations')
  }
}
