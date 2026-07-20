import { useEffect, useRef, useState } from 'react'
import { Send, Paperclip, X, FileText, AlertCircle } from 'lucide-react'
import { api, ApiError } from '../lib/api.js'
import { formatBytes } from '../lib/format.js'

const MAX_BYTES = 16 * 1024 * 1024

const ACCEPT = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  // Uploadable, but still rendered as chips — no players.
  'video/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/webm',
].join(',')

export default function ReplyBox({ conversationId, onSend, disabled }) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const [attachment, setAttachment] = useState(null) // {file, previewUrl, isImage}
  const [error, setError] = useState(null)
  const textareaRef = useRef(null)
  const fileRef = useRef(null)

  // Auto-grow from 1 row up to 5, then scroll. Measured from the element's own
  // computed line-height so it tracks the 14px/16px responsive font sizing.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return

    const styles = window.getComputedStyle(el)
    const lineHeight = parseFloat(styles.lineHeight) || 20
    const chrome =
      parseFloat(styles.paddingTop) +
      parseFloat(styles.paddingBottom) +
      parseFloat(styles.borderTopWidth) +
      parseFloat(styles.borderBottomWidth)

    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * 5 + chrome)}px`
  }, [value])

  // Revoke the object URL when the attachment changes or unmounts.
  useEffect(() => {
    const url = attachment?.previewUrl
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [attachment])

  // Switching conversations must not carry an attachment across.
  useEffect(() => {
    setAttachment(null)
    setError(null)
    setValue('')
  }, [conversationId])

  const attach = (file) => {
    if (!file) return
    setError(null)

    const mime = String(file.type || '').toLowerCase().split(';')[0]
    if (!ACCEPT.split(',').includes(mime)) {
      setError(`Files of type "${mime || 'unknown'}" are not supported`)
      return
    }
    if (file.size > MAX_BYTES) {
      setError('File is larger than the 16MB limit')
      return
    }

    const isImage = mime.startsWith('image/')
    setAttachment({
      file,
      isImage,
      previewUrl: isImage ? URL.createObjectURL(file) : null,
    })
  }

  const clearAttachment = () => {
    setAttachment(null)
    setError(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const submit = async () => {
    const text = value.trim()
    if ((!text && !attachment) || sending || disabled) return

    setSending(true)
    setError(null)
    try {
      let media = null

      if (attachment) {
        // Upload first — a failed upload must not produce a half-sent message.
        const uploaded = await api.upload(conversationId, attachment.file)
        media = {
          media_path: uploaded.media_path,
          media_type: uploaded.media_type,
          media_mime: uploaded.media_mime,
          media_filename: uploaded.media_filename,
          media_size: uploaded.media_size,
        }
      }

      await onSend(text, media)
      setValue('')
      clearAttachment()
    } catch (err) {
      // Inline, never thrown past this boundary.
      setError(err instanceof ApiError ? err.message : 'Could not send. Please try again.')
    } finally {
      setSending(false)
    }
  }

  // Paste an image straight from the clipboard.
  const onPaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))
    if (!item) return
    const file = item.getAsFile()
    if (!file) return
    e.preventDefault()
    attach(file)
  }

  const canSend = Boolean(value.trim() || attachment)

  return (
    <div className="reply">
      {error ? (
        <div className="reply-error" role="alert">
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
      ) : null}

      {attachment ? (
        <div className="reply-attach">
          {attachment.isImage ? (
            <img className="reply-attach-thumb" src={attachment.previewUrl} alt="" />
          ) : (
            <span className="reply-attach-icon">
              <FileText size={16} />
            </span>
          )}
          <span className="reply-attach-body">
            <span className="reply-attach-name">{attachment.file.name}</span>
            <span className="reply-attach-size">{formatBytes(attachment.file.size)}</span>
          </span>
          <button
            type="button"
            className="reply-attach-remove"
            aria-label="Remove attachment"
            onClick={clearAttachment}
            disabled={sending}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}

      <div className="reply-inner">
        <input
          ref={fileRef}
          type="file"
          className="visually-hidden"
          accept={ACCEPT}
          onChange={(e) => {
            attach(e.target.files?.[0])
            e.target.value = ''
          }}
        />

        <button
          type="button"
          className="reply-attach-btn"
          aria-label="Attach a file"
          title="Attach a file"
          disabled={disabled || sending}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={17} />
        </button>

        <textarea
          ref={textareaRef}
          className="reply-input"
          rows={1}
          placeholder={attachment ? 'Add a caption…' : 'Write a reply…'}
          aria-label={attachment ? 'Attachment caption' : 'Reply message'}
          value={value}
          disabled={disabled || sending}
          onChange={(e) => setValue(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter makes a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />

        <button
          type="button"
          className="reply-send"
          aria-label={sending ? 'Sending' : 'Send message'}
          disabled={disabled || sending || !canSend}
          onClick={submit}
        >
          {sending ? <span className="spinner" /> : <Send size={16} />}
        </button>
      </div>

      <div className="reply-hint desktop-only">Enter to send · Shift + Enter for a new line</div>
    </div>
  )
}
