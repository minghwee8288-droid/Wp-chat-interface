import { getDb, unwrap } from '../../_lib/db.js'
import { requireAdmin } from '../../_lib/auth.js'
import { json, badRequest, notFound, serverError, readJson } from '../../_lib/respond.js'
import { runSyncStep } from '../../_lib/sync.js'

// How long a step may hold the job before another step is allowed to take over.
// Long enough to cover a slow media-heavy step, short enough that a crashed
// step frees the job quickly for a resume.
const LEASE_MS = 120 * 1000

// Cap the errors array so a pathological run can't grow the row unbounded.
const MAX_ERRORS = 50

const TERMINAL = new Set(['done', 'failed', 'canceled'])

/**
 * POST /api/sync/step  (admin)  body: { job_id }
 *
 * Runs ONE bounded unit of work and returns the updated job. The client calls
 * this in a loop until job.status is terminal. A soft lease stops two loops
 * (e.g. two tabs) from double-driving the same job.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const { job_id } = await readJson(request)
  const jobId = Number(job_id)
  if (!Number.isInteger(jobId) || jobId <= 0) return badRequest('job_id is required')

  try {
    const db = getDb(env)

    const job = unwrap(
      await db.from('wp_chat_sync_jobs').select('*').eq('id', jobId).maybeSingle()
    )
    if (!job) return notFound('Sync job not found')
    if (TERMINAL.has(job.status)) return json({ ok: true, job, done: true })

    // Lease: if a fresh lease is held, another step is mid-flight — tell the
    // client to back off rather than running the same unit twice.
    const now = Date.now()
    if (job.lease_until && new Date(job.lease_until).getTime() > now) {
      return json({ ok: true, job, busy: true })
    }

    // Claim the lease.
    unwrap(
      await db
        .from('wp_chat_sync_jobs')
        .update({
          status: 'running',
          lease_until: new Date(now + LEASE_MS).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
    )

    let result
    try {
      result = await runSyncStep(env, db, job)
    } catch (err) {
      // A thrown step fails the whole job — the cursor is preserved so an admin
      // could inspect and retry, but we do not auto-loop on a hard error.
      const patch = {
        status: 'failed',
        lease_until: null,
        last_error: String(err?.message || err).slice(0, 500),
        updated_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      }
      const failed = unwrap(
        await db.from('wp_chat_sync_jobs').update(patch).eq('id', jobId).select('*').single()
      )
      return json({ ok: true, job: failed, done: true })
    }

    // Merge counters and record any soft (per-chat) error without stopping.
    const errors = Array.isArray(job.errors) ? [...job.errors] : []
    if (result.error) {
      errors.push({ chat: result.errorChat || null, error: String(result.error).slice(0, 200) })
    }

    const patch = {
      cursor: result.cursor || job.cursor,
      messages_added: (Number(job.messages_added) || 0) + (result.addAdded || 0),
      media_failed: (Number(job.media_failed) || 0) + (result.addMediaFailed || 0),
      conversations_done: (Number(job.conversations_done) || 0) + (result.addConversationsDone || 0),
      errors: errors.slice(-MAX_ERRORS),
      last_error: result.error ? String(result.error).slice(0, 500) : job.last_error,
      // Release the lease so the next step can proceed immediately.
      lease_until: null,
      status: result.done ? 'done' : 'running',
      updated_at: new Date().toISOString(),
      ...(result.done ? { finished_at: new Date().toISOString() } : {}),
    }

    const updated = unwrap(
      await db.from('wp_chat_sync_jobs').update(patch).eq('id', jobId).select('*').single()
    )

    return json({ ok: true, job: updated, done: Boolean(result.done), backoff: Boolean(result.backoff) })
  } catch (err) {
    return serverError(err.message || 'Sync step failed')
  }
}
