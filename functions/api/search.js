import { getDb, unwrap } from '../_lib/db.js'
import { requireAuth } from '../_lib/auth.js'
import { json, badRequest, serverError } from '../_lib/respond.js'
import {
  SEARCH_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  likePattern,
  normalizeQuery,
  beforeCursor,
  buildSnippet,
} from '../_lib/search.js'

const MESSAGE_FIELDS =
  'id, conversation_id, direction, body, media_caption, media_type, sender_name, sender_number, created_at'

const CONVERSATION_FIELDS =
  'id, customer_name, customer_number, is_group, avatar_path, avatar_error'

/**
 * GET /api/search?q=...&limit=25&cursor_at=...&cursor_id=...
 *
 * Message-body search across every conversation the caller may see.
 * Newest first, keyset-paginated, never unbounded.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const url = new URL(request.url)
  const query = normalizeQuery(url.searchParams.get('q'))

  // Not an error — the field is simply not yet worth querying. Returning an
  // empty page keeps the client from having to special-case a 400 for every
  // first keystroke.
  if (!query) {
    return json({ ok: true, query: '', results: [], has_more: false, next_cursor: null })
  }

  const requested = Number(url.searchParams.get('limit'))
  const limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, SEARCH_MAX_PAGE_SIZE)
    : SEARCH_PAGE_SIZE

  try {
    const db = getDb(env)

    // ---- Scope -------------------------------------------------------
    // Messages carry no assignment of their own, so an agent's reach has to
    // be resolved through the conversations table first. Skipping this would
    // leak every other agent's message bodies through search — the one place
    // in the app where a row can be surfaced without going through
    // requireConversationAccess.
    let allowedIds = null
    if (auth.user.role !== 'admin') {
      const mine =
        unwrap(
          await db
            .from('wp_chat_conversations')
            .select('id')
            .eq('assigned_user_id', auth.user.id)
        ) || []

      allowedIds = mine.map((c) => c.id)
      if (!allowedIds.length) {
        return json({ ok: true, query, results: [], has_more: false, next_cursor: null })
      }
    }

    // ---- Page --------------------------------------------------------
    let builder = db
      .from('wp_chat_messages')
      .select(MESSAGE_FIELDS)
      .ilike('search_text', likePattern(query))
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      // One extra row is the has_more probe — cheaper and race-free compared
      // with a second count query.
      .limit(limit + 1)

    if (allowedIds) builder = builder.in('conversation_id', allowedIds)

    const cursorAt = url.searchParams.get('cursor_at')
    const rawCursorId = url.searchParams.get('cursor_id')
    // Not Number(rawCursorId): a missing param is null, Number(null) is 0, and
    // 0 is a perfectly good integer — so a half-supplied cursor would silently
    // page from id 0 instead of being rejected.
    const cursorId = rawCursorId === null ? null : Number(rawCursorId)

    if (cursorAt !== null && cursorId !== null && Number.isInteger(cursorId)) {
      builder = builder.or(beforeCursor({ created_at: cursorAt, id: cursorId }))
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
