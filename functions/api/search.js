import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth, requireConversationAccess } from '../_lib/auth.js'
import { json, badRequest, serverError } from '../_lib/respond.js'
import {
  SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_SCOPED_MAX_PAGE_SIZE,
  likePattern,
  normalizeQuery,
  beforeCursor,
  afterCursor,
  buildSnippet,
} from '../_lib/search.js'

const MESSAGE_FIELDS =
  'id, conversation_id, direction, body, media_caption, media_type, sender_name, sender_number, created_at'

const CONVERSATION_FIELDS =
  'id, customer_name, customer_number, is_group, avatar_path, avatar_error'

/**
 * GET /api/search?q=...&conversation_id=N&limit=25&cursor_at=...&cursor_id=...
 *
 * Message-body search. Global by default, across every conversation the caller
 * may see; scoped to one conversation when conversation_id is supplied.
 *
 * Ordering follows the use: global results are newest-first, because recency is
 * the best relevance proxy for an inbox. Scoped results are OLDEST-first, so
 * stepping through them with the in-thread chevrons walks the conversation in
 * reading order.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const query = normalizeQuery(url.searchParams.get('q'))

  const rawConversationId = url.searchParams.get('conversation_id')
  let conversationId = null
  if (rawConversationId !== null) {
    conversationId = Number(rawConversationId)
    if (!Number.isInteger(conversationId) || conversationId <= 0) {
      return badRequest('conversation_id must be a positive integer')
    }
  }

  const scoped = conversationId !== null

  // Not an error — the field is simply not yet worth querying. Returning an
  // empty page keeps the client from having to special-case a 400 for every
  // first keystroke.
  if (!query) {
    return json({ ok: true, query: '', results: [], has_more: false, next_cursor: null })
  }

  const maxLimit = scoped ? SEARCH_SCOPED_MAX_PAGE_SIZE : SEARCH_MAX_PAGE_SIZE
  const requested = Number(url.searchParams.get('limit'))
  const limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, maxLimit)
    : SEARCH_PAGE_SIZE

  try {
    const db = getDb(env)

    // ---- Scope -------------------------------------------------------
    // Global search now spans every conversation for everyone: assignment is no
    // longer a permission boundary, so the old per-agent id list is gone. A
    // scoped search still passes through requireConversationAccess so a
    // conversation id that does not exist 404s rather than returning [].
    if (scoped) {
      const access = await requireConversationAccess(env, auth.user, conversationId)
      if (access.response) return access.response
    }

    // ---- Page --------------------------------------------------------
    // Ascending for a scoped search, descending for a global one. The cursor
    // below has to follow the same direction or paging walks backwards.
    const ascending = scoped

    let builder = db
      .from('wp_chat_messages')
      .select(MESSAGE_FIELDS)
      .ilike('search_text', likePattern(query))
      .order('created_at', { ascending })
      .order('id', { ascending })
      // One extra row is the has_more probe — cheaper and race-free compared
      // with a second count query.
      .limit(limit + 1)

    if (scoped) builder = builder.eq('conversation_id', conversationId)

    const cursorAt = url.searchParams.get('cursor_at')
    const rawCursorId = url.searchParams.get('cursor_id')
    // Not Number(rawCursorId): a missing param is null, Number(null) is 0, and
    // 0 is a perfectly good integer — so a half-supplied cursor would silently
    // page from id 0 instead of being rejected.
    const cursorId = rawCursorId === null ? null : Number(rawCursorId)

    if (cursorAt !== null && cursorId !== null && Number.isInteger(cursorId)) {
      const cursor = { created_at: cursorAt, id: cursorId }
      builder = builder.or(ascending ? afterCursor(cursor) : beforeCursor(cursor))
    } else if (cursorAt !== null || rawCursorId !== null) {
      return badRequest('cursor_at and cursor_id must be supplied together')
    }

    const rows = unwrap(await builder) || []
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    if (!page.length) {
      return json({ ok: true, query, results: [], has_more: false, next_cursor: null })
    }

    // ---- Decorate ----------------------------------------------------
    // One extra round trip rather than an embedded select, matching
    // /api/conversations — this does not depend on PostgREST inferring the
    // foreign key.
    const conversationIds = [...new Set(page.map((m) => m.conversation_id))]
    const conversations =
      unwrap(
        await db
          .from('wp_chat_conversations')
          .select(CONVERSATION_FIELDS)
          .in('id', conversationIds)
      ) || []

    const byId = new Map(conversations.map((c) => [String(c.id), c]))

    const results = page.map((m) => {
      const conversation = byId.get(String(m.conversation_id)) || null

      // The indexed text is body + caption + sender name. Attribute the hit to
      // whichever of those actually contains it, so a group search on an
      // agent's name shows their message rather than an unhighlighted snippet.
      const bodyText = m.body || m.media_caption || ''
      const hit =
        buildSnippet(bodyText, query) ||
        buildSnippet(m.sender_name, query) || {
          // Reachable when the match straddles the single space this column
          // joins its inputs with. Rare, and a plain snippet is still useful.
          snippet: bodyText.slice(0, 160),
          match_start: -1,
          match_length: 0,
        }

      return {
        message_id: m.id,
        conversation_id: m.conversation_id,
        direction: m.direction,
        created_at: m.created_at,
        media_type: m.media_type || null,

        conversation_name: conversation?.customer_name?.trim() || null,
        conversation_number: conversation?.customer_number || null,
        is_group: Boolean(conversation?.is_group),
        avatar_path: conversation?.avatar_path || null,
        avatar_error: Boolean(conversation?.avatar_error),

        // Only meaningful in a group; 1:1 senders are the contact themselves.
        sender_name: conversation?.is_group ? m.sender_name || null : null,
        sender_number: conversation?.is_group ? m.sender_number || null : null,

        ...hit,
      }
    })

    const last = page[page.length - 1]

    return json({
      ok: true,
      query,
      conversation_id: conversationId,
      results,
      has_more: hasMore,
      next_cursor: hasMore ? { at: last.created_at, id: last.id } : null,
    })
  } catch (err) {
    // A missing search_text column is the one failure worth naming, because
    // it means sql/001_message_search.sql has not been run.
    const message = String(err?.message || '')
    if (/search_text/.test(message)) {
      return serverError('Search is not set up yet — run sql/001_message_search.sql')
    }
    return serverError(message || 'Search failed')
  }
}
