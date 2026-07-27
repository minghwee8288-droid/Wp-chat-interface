import { requireAdmin } from '../../_lib/auth.js'
import { clearAutoHalt } from '../../_lib/channel-gap.js'
import { json } from '../../_lib/respond.js'

/**
 * POST /api/channel/clear-halt  (admin)
 *
 * Clears an account-level auto-recovery halt (e.g. after a Whapi 402 was
 * resolved), so automatic gap recovery resumes on the next reconnect. Explicit
 * admin action — the "Clear" control on the Sync page.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  await clearAutoHalt(env)
  return json({ ok: true })
}
