import { useMemo, useRef, useState } from 'react'
import { Search, X, Inbox as InboxIcon, Plus, SlidersHorizontal, Sparkles } from 'lucide-react'
import SummaryPopover from './SummaryPopover.jsx'
import {
  displayName,
  relativeStamp,
  matchesQuery,
  firstName,
  avatarIndex,
} from '../lib/format.js'
import ContactAvatar from './ContactAvatar.jsx'
import ConversationFilters, {
  EMPTY_FILTERS,
  hasActiveFilters,
  matchesFilters,
} from './ConversationFilters.jsx'
import SearchResults from './SearchResults.jsx'
import { useMessageSearch } from '../lib/useMessageSearch.js'

// Attention levels that get a coloured bar down the row's left edge. The
// colours and the bar itself live in the stylesheet
// (.conv-row[data-attention]); this only decides which rows are marked.
// 'general' is deliberately absent — it, and any conversation with no flagged
// summary, leaves the row exactly as it was.
const FLAGGED_LEVELS = new Set(['team', 'management'])

// A group preview reads "Sender: message". Split on the FIRST ": " so the
// sender label can be styled apart from the body; the message may itself
// contain colons and stays intact. One-to-one previews (isGroup=false) render
// as a plain string. The trailing space stays with the message so the two
// segments keep their single space and truncate together on one line.
function renderPreview(text, isGroup) {
  if (!isGroup) return text
  const sep = text.indexOf(': ')
  if (sep === -1) return text
  return (
    <>
      <span className="conv-snippet-sender">{text.slice(0, sep + 1)}</span>
      {text.slice(sep + 1)}
    </>
  )
}

export default function ConversationList({
  conversations,
  openId,
  onOpen,
  loading,
  onNewMessage,
  users = [],
  summaryCache = null,
}) {
  const [query, setQuery] = useState('')
  // Filters live here, not in the URL — they reset on reload by design.
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  // The open short-summary popover ({ conversation, rect }).
  const [popover, setPopover] = useState(null)

  // The cache is normally supplied by Inbox, which also background-preloads
  // into it. The local fallback keeps this component usable on its own — it
  // simply starts empty, so every popover does its own lazy fetch as before.
  const ownCache = useRef(new Map())
  const cache = summaryCache ?? ownCache.current

  // Name and number matching stays client-side: every conversation the caller
  // may see is already loaded, so this is instant and needs no round trip.
  // Only message BODIES require the database.
  const searched = useMemo(
    () => conversations.filter((c) => matchesQuery(c, query)),
    [conversations, query]
  )

  const search = useMessageSearch(query)
  // Results mode is keyed on the typed query, not on the search status, so the
  // list switches over on the first keystroke rather than when a request
  // returns.
  const searching = query.trim().length > 0

  const filtered = useMemo(
    () => searched.filter((c) => matchesFilters(c, filters)),
    [searched, filters]
  )

  const filtersActive = hasActiveFilters(filters)
  // Distinguishes "filters hid everything" from "there is nothing at all".
  const hiddenByFilters = filtersActive && searched.length > 0 && filtered.length === 0

  return (
    <>
      <div className="search-wrap">
        <div className="search">
          <Search size={15} className="search-icon" />
          <input
            className="input"
            type="search"
            placeholder="Search messages, names, numbers"
            aria-label="Search messages and conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <X size={15} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Filters describe conversations; a results list also contains message
          rows they cannot express. Rather than leave a control on screen that
          silently stops applying, it is withdrawn for the duration. */}
      {searching ? null : (
        <ConversationFilters users={users} filters={filters} onChange={setFilters} />
      )}

      {searching ? (
        <SearchResults
          query={query}
          nameMatches={searched}
          search={search}
          openId={openId}
          onOpen={onOpen}
        />
      ) : (
      <div className="conv-list">
        {filtered.length === 0 ? (
          <div className="empty">
            {hiddenByFilters ? (
              <>
                <SlidersHorizontal size={26} />
                <div className="empty-title">No conversations match these filters</div>
                <div className="empty-sub">
                  {filters.unassigned && filters.agentIds.length
                    ? 'Unassigned and a specific agent cannot both be true.'
                    : 'Try widening or clearing the filters.'}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                {/* Only reachable with an empty field — a non-empty one is
                    handled by SearchResults, which has its own distinct
                    "no matches" state. */}
                <InboxIcon size={26} />
                <div className="empty-title">
                  {loading ? 'Loading…' : 'No conversations yet'}
                </div>
                {!loading ? (
                  <div className="empty-sub">
                    Incoming WhatsApp messages will appear here.
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          filtered.map((conversation) => {
            const unread = Number(conversation.unread_count) || 0
            const isActive = String(conversation.id) === String(openId)
            const name = displayName(conversation)
            // Whitespace-only bodies count as empty too.
            const preview = String(conversation.last_message_body || '').trim()
            const isGroup = Boolean(conversation.is_group)
            const assignee = firstName(conversation.assigned_to)
            // Same hash as the avatars, keyed on the USER ID so a rename never
            // changes an agent's colour.
            const agentColor =
              assignee && conversation.assigned_user_id != null
                ? avatarIndex(conversation.assigned_user_id)
                : null
            // undefined omits the attribute entirely, so an unflagged row is
            // left alone. The open row is NOT excluded: the flag is a bar down
            // the left edge now, not a background, so it no longer competes
            // with the selected-row highlight and a flagged conversation stays
            // flagged while you are reading it.
            const attention = FLAGGED_LEVELS.has(conversation.attention_level)
              ? conversation.attention_level
              : undefined

            return (
              <div key={conversation.id} className="conv-row-wrap">
              {/* A role=button div (not a <button>) so the ✦ Summary control can
                  nest inside on line 3. Keyboard behaviour is added back below. */}
              <div
                className={`conv-row${isActive ? ' is-active' : ''}${unread > 0 ? ' is-unread' : ''}`}
                role="button"
                tabIndex={0}
                aria-current={isActive ? 'true' : undefined}
                data-attention={attention}
                onClick={() => onOpen(conversation.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(conversation.id)
                  }
                }}
              >
                <ContactAvatar conversation={conversation} />

                <div className="conv-body">
                  <div className="conv-top">
                    <span className="conv-name">{name}</span>
                    <span className="conv-time">
                      {relativeStamp(conversation.last_message_at)}
                    </span>
                  </div>

                  <div className="conv-preview">
                    <span className={`conv-snippet${preview ? '' : ' is-empty'}`}>
                      {/* A group's inbound preview already carries
                          "Sender: " from the webhook, so only outbound needs a
                          prefix here. In a group row the leading "Sender:" is
                          split into its own span so it can carry a heavier
                          weight than the message; one-to-one rows are rendered
                          as a plain string, unchanged. */}
                      {preview
                        ? renderPreview(
                            `${conversation.last_direction === 'outbound' ? 'You: ' : ''}${preview}`,
                            isGroup
                          )
                        : 'No messages yet'}
                    </span>
                    {unread > 0 ? (
                      <span className="conv-badge" aria-label={`${unread} unread`}>
                        {unread > 99 ? '99+' : unread}
                      </span>
                    ) : null}
                    {/* The agent badge now shares line 2 with the preview, so a
                        1:1 row is just two lines and sits shorter. */}
                    <span
                      className={`conv-assignee${assignee ? '' : ' is-unassigned'}`}
                      data-agent={agentColor ?? undefined}
                    >
                      {assignee || 'Unassigned'}
                    </span>
                  </div>

                  {/* Line 3: member count / "Direct" on the left, the compact
                      ✦ Summary button on the right (under the agent badge).
                      Nested here since the row is a role=button div; a tap on it
                      opens the popover, not the chat (stopPropagation). Only taps
                      fetch the summary — lazy. */}
                  <div className="conv-meta">
                    <span className="conv-number">
                      {isGroup
                        ? conversation.member_count
                          ? `${conversation.member_count} member${conversation.member_count === 1 ? '' : 's'}`
                          : 'Group'
                        : 'Direct'}
                    </span>
                    <button
                      type="button"
                      className="conv-summary-btn"
                      aria-label={`AI summary for ${name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setPopover({ conversation, rect: e.currentTarget.getBoundingClientRect() })
                      }}
                    >
                      <Sparkles size={12} className="conv-summary-spark" />
                      <span className="conv-summary-label">Summary</span>
                    </button>
                  </div>
                </div>
              </div>
              </div>
            )
          })
        )}
      </div>
      )}

      {/* Mobile-only floating action; desktop uses the "+" in the list header. */}
      <button
        type="button"
        className="conv-fab"
        aria-label="New message"
        onClick={onNewMessage}
      >
        <Plus size={24} />
      </button>

      {popover ? (
        <SummaryPopover
          conversation={popover.conversation}
          anchorRect={popover.rect}
          cache={cache}
          onClose={() => setPopover(null)}
        />
      ) : null}
    </>
  )
}
