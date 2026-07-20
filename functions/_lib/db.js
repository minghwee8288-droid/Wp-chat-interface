import postgres from 'postgres'

// One client per isolate. Pages Functions re-use the module scope across
// requests on a warm isolate, so we memoize instead of reconnecting per call.
let sql = null
let cachedUrl = null

export function getSql(env) {
  if (!env?.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured')
  }
  if (sql && cachedUrl === env.DATABASE_URL) return sql

  cachedUrl = env.DATABASE_URL
  sql = postgres(env.DATABASE_URL, {
    ssl: 'require',
    // Supabase's pooler runs in transaction mode; named prepared statements
    // are not supported there.
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    fetch_types: false,
  })
  return sql
}

/**
 * Parameterized query helper.
 *
 *   await query(env, 'select * from wp_chat_users where email = $1', [email])
 *
 * Values are always bound by the driver — never interpolated into the string.
 */
export async function query(env, text, params = []) {
  const client = getSql(env)
  return client.unsafe(text, params)
}

/** Convenience: first row or null. */
export async function queryOne(env, text, params = []) {
  const rows = await query(env, text, params)
  return rows[0] ?? null
}
