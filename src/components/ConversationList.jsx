import { useMemo, useState } from 'react'
import { Search, X, Inbox as InboxIcon, User } from 'lucide-react'
import { displayName, formatNumber, relativeStamp, matchesQuery, initials } from '../lib/format.js'

export default function ConversationList({ conversations, openId, onOpen, loading }) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(
    () => conversations.filter((c) => matchesQuery(c, query)),
    [conversations, query]
  )

  return (
    <>
      <div className="search-wrap">
        <div className="search">
          <Search size={16} className="search-icon" />
          <input
            className="input"
            type="search"
            placeholder="Search name or number"
            aria-label="Search conversations"
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

      <div className="conv-list">
        {filtered.length === 0 ? (
          <div className="empty">
            <InboxIcon size={26} />
            {query ? (
              <div className="empty-title">No conversations match</div>
            ) : (
              <>
                <div className="empty-title">{loading ? 'Loading…' : 'No conversations yet'}</div>
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

            return (
              <button
                key={conversation.id}
                type="button"
                className={`conv-row${isActive ? ' is-active' : ''}${unread > 0 ? ' is-unread' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onOpen(conversation.id)}
              >
                <span className="conv-avatar" aria-hidden="true">
                  {initials(name)}
                </span>

                <div className="conv-body">
                  <div className="conv-top">
                    <span className="conv-name">{name}</span>
                    <span className="conv-time">
                      {relativeStamp(conversation.last_message_at)}
                    </span>
                  </div>

                  <div className="conv-preview">
                    <span className={`conv-snippet${preview ? '' : ' is-empty'}`}>
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

                  <div className="conv-meta">
                    <span>{formatNumber(conversation.customer_number)}</span>
                    {conversation.assigned_to ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <User size={11} />
                        <span>{conversation.assigned_to}</span>
                      </>
                    ) : null}
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>
    </>
  )
}
