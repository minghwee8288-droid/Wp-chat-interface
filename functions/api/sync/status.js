import { getDb, unwrap } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { json, notFound, serverError } from '../../_lib/respond.js'

/**
 * GET /api/sync/status            (admin) — the most recent jobs
 * GET /api/sync/status?job_id=N   (admin) — one job, for polling
 *
 * The job row carries its own progress counters, so polling this is how the UI
 * survives a page reload mid-sync.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const jobIdRaw = url.searchParams.get('job_id')

  try {
    const db = getDb(env)

    if (jobIdRaw !== null) {
      const jobId = Number(jobIdRaw)
      if (!Number.isInteger(jobId) || jobId <= 0) return notFound('Sync job not found')
      const job = unwrap(
        await db.from('wp_chat_sync_jobs').select('*').eq('id', jobId).maybeSingle()
      )
      if (!job) return notFound('Sync job not found')
      return json({ ok: true, job })
    }

    const jobs =
      unwrap(
        await db
          .from('wp_chat_sync_jobs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(10)
      ) || []

    return json({ ok: true, jobs })
  } catch (err) {
    return serverError(err.message || 'Failed to load sync status')
  }
}
