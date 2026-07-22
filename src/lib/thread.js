// Ordering and merging for a windowed thread.
//
// Lives in its own module rather than inside Inbox.jsx so it can be tested
// directly — a mirrored copy in a test file would drift.

/**
 * Thread order is the tuple (created_at, id), matching the server.
 *
 * Ordering on id alone is wrong and will become visibly wrong: the planned
 * three-month backfill inserts OLD messages with NEW ids, so every one of them
 * would sort to the bottom of its thread.
 */
export function byPosition(a, b) {
  const ta = new Date(a.created_at).getTime()
  const tb = new Date(b.created_at).getTime()
  if (ta !== tb) return ta - tb
  return Number(a.id) - Number(b.id)
}

/**
 * Fold a freshly fetched page into the loaded window.
 *
 * A plain replace — which is what the poll used to do — would discard any
 * older pages the reader had scrolled up to. Keying by id means an existing
 * row picks up its latest status (queued -> sent, or a failure) while
 * everything outside the incoming page is preserved.
 *
 * Incoming rows win on conflict: they are always the fresher copy.
 */
export function mergeMessages(existing, incoming) {
  if (!existing?.length) return incoming || []
  if (!incoming?.length) return existing

  const byId = new Map(existing.map((m) => [String(m.id), m]))
  for (const message of incoming) byId.set(String(message.id), message)

  return [...byId.values()].sort(byPosition)
}
