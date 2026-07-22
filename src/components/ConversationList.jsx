import { useMemo, useState } from 'react'
import { Search, X, Inbox as InboxIcon, Plus, SlidersHorizontal } from 'lucide-react'
import {
  displayName,
  formatNumber,
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

export default function ConversationList({
  conversations,
  openId,
  onOpen,
  loading,
  onNewMessage,
  users = [],
}) {
  const [query, setQuery] = useState('')
  // Filters live here, not in the URL — they reset on reload by design.
  const [filters, setFilters] = useState(EMPTY_FILTERS)

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
            // A named contact keeps its number on line 3; an unnamed one has
            // already been promoted to the name, so showing it twice is noise.
            const hasRealName = Boolean(conversation.customer_name?.trim())
            const isGroup = Boolean(conversation.is_group)
            const assignee = firstName(conversation.assigned_to)
            // Same hash as the avatars, keyed on the USER ID so a rename never
            // changes an agent's colour.
            const agentColor =
              assignee && conversation.assigned_user_id != null
                ? avatarIndex(conversation.assigned_user_id)
                : null

            return (
              <button
                key={conversation.id}
                type="button"
                className={`conv-row${isActive ? ' is-active' : ''}${unread > 0 ? ' is-unread' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onOpen(conversation.id)}
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
                          prefix here. */}
                      {preview
                        ? `${conversation.last_direction === 'outbound' ? 'You: ' : ''}${preview}`
                        : 'No messages yet'}
                    </span>
                    {unread > 0 ? (
                      <span className="conv-badge" aria-label={`${unread} unread`}>
                        {unread > 99 ? '99+' : unread}
                      </span>
                    ) : null}
                  </div>

                  {/* Line 3 always renders so the row height is constant, and
                      it is where the assignee lives — the badge never shares a
                      line with it, so neither can displace the other. */}
                  <div className="conv-meta">
                    <span className="conv-number">
                      {isGroup
                        ? conversation.member_count
                          ? `${conversation.member_count} member${conversation.member_count === 1 ? '' : 's'}`
                          : 'Group'
                        : hasRealName
                          ? formatNumber(conversation.customer_number)
                          : ''}
                    </span>
                    <span
                      className={`conv-assignee${assignee ? '' : ' is-unassigned'}`}
                      data-agent={agentColor ?? undefined}
                    >
                      {assignee || 'Unassigned'}
                    </span>
                  </div>
                </div>
              </button>
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
    </>
  )
}
