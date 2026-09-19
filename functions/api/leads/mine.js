// ─────────────────────────────────────────────────────────────────────────────
// SELF-CONTAINED FEATURE: "New lead has arrived" banner.
//
// This whole feature is deliberately isolated so it can be deleted in one go.
// To remove it entirely, delete exactly these four things:
//   1. functions/api/leads/mine.js          (this file)
//   2. src/features/leads/                  (the client feature folder)
//   3. the <NewLeadBanner /> line + its import in src/pages/Inbox.jsx
//   4. the leads-feature.css import in src/main.jsx
// Nothing else in the codebase references it, and no migration was applied.
// ─────────────────────────────────────────────────────────────────────────────

import { getDb, unwrap } from '../../_lib/db.js'
import { requireAuth } from '../../_lib/auth.js'
import { json, serverError } from '../../_lib/respond.js'

/**
 * The columns the panel renders — the enquiry detail, not the pipeline
 * bookkeeping. Deliberately still a list rather than `*`: the conversion,
 * follow-up and routing columns (converted_case_id, follow_up_note,
 * lost_reason, tenant_id, branch_id …) have no place on the wire.
 *
 * Both `requirement` and `interest_type` are sent. They are NOT duplicates —
 * interest_type is the classified category ('passport_renewal') and is set on
 * every row, while requirement is a looser free-text note ('childcare') that is
 * frequently null. Showing only one would lose information on most leads.
 */
const LEAD_COLUMNS = [
  'id',
  'lead_number',
  'full_name',
  'phone',
  'email',
  'source',
  'interest_type',
  'requirement',
  'preferred_nationality',
  'urgency',
  'budget',
  'temperature',
  'summary',
  'status',
  'owner_profile_id',
  'created_at',
].join(', ')

/** Newest first, and never flood the header with an unbounded list. */
const MAX_LEADS = 20

/**
 * GET /api/leads/mine
 *
 * The leads this caller should be alerted about.
 *
 * Identity bridge: the inbox authenticates against `wp_chat_users`, while
 * `leads.owner_profile_id` points into `profiles` — two separate tables with no
 * foreign key between them. EMAIL is the only thing they share, so the caller's
 * wp_chat_users.email is matched (case-insensitively) against profiles.email to
 * find the profile id that leads are actually owned by.
 *
 * Visibility:
 *   admin → every lead with status 'new'
 *   agent → only leads whose owner_profile_id is their matched profile id
 *
 * An agent with no matching profile row sees nothing. That is the correct
 * answer, not an error: no profile means no lead can name them as owner.
 * Unowned leads (owner_profile_id IS NULL) likewise stay admin-only rather than
 * being shown to everyone, since "unowned" is not a claim about who handles it.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const { user } = auth

  try {
    const db = getDb(env)
    const isAdmin = user.role === 'admin'

    let profileId = null

    if (!isAdmin) {
      profileId = await findProfileIdByEmail(db, user.email)
      // No profile → no lead can be owned by this user. Answer an empty list
      // rather than falling through to an unfiltered query, which would leak
      // every lead to an agent whose email simply has not been mirrored yet.
      if (!profileId) return json({ ok: true, leads: [], profile_id: null })
    }

    let query = db
      .from('leads')
      .select(LEAD_COLUMNS)
      .eq('status', 'new')
      // Archived leads are done with, whoever owns them.
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(MAX_LEADS)

    if (!isAdmin) query = query.eq('owner_profile_id', profileId)

    const leads = unwrap(await query) || []

    return json({ ok: true, leads, profile_id: profileId })
  } catch (err) {
    return serverError(err.message || 'Failed to load leads')
  }
}

/**
 * profiles.id for this email, or null.
 *
 * Mirrors the escaping/re-check discipline of findUserByEmail in _lib/db.js:
 * PostgREST cannot express `lower(col) = lower($1)`, and `ilike` would treat a
 * `%` or `_` inside an address as a wildcard — so the pattern is escaped, and
 * the JS equality check below is the authoritative comparison. Any row that
 * slipped through the pattern cannot produce a false match here.
 */
async function findProfileIdByEmail(db, email) {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null

  const pattern = normalized.replace(/([\%_])/g, '\$1')

  const rows = unwrap(
    await db.from('profiles').select('id, email').ilike('email', pattern).limit(10)
  )

  const match = rows?.find((row) => String(row.email || '').toLowerCase() === normalized)
  return match?.id ?? null
}
