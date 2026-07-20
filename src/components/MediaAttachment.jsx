import { useEffect, useState } from 'react'
import { FileText, Download, ImageOff, Film, Music, FileSpreadsheet } from 'lucide-react'
import { api } from '../lib/api.js'
import { formatBytes } from '../lib/format.js'

// Signed URLs last 60 minutes; cache them per path so a 4s thread poll doesn't
// re-mint one on every render. Module scope, so it survives re-renders.
const urlCache = new Map()

function useSignedUrl(mediaPath) {
  const [state, setState] = useState(() =>
    urlCache.has(mediaPath) ? { url: urlCache.get(mediaPath), error: null } : { url: null, error: null }
  )

  useEffect(() => {
    if (!mediaPath) return undefined
    if (urlCache.has(mediaPath)) {
      setState({ url: urlCache.get(mediaPath), error: null })
      return undefined
    }

    const controller = new AbortController()
    let cancelled = false

    api
      .mediaUrl(mediaPath, controller.signal)
      .then((data) => {
        if (cancelled) return
        urlCache.set(mediaPath, data.url)
        // Re-mint comfortably before the 60 minute expiry.
        setTimeout(() => urlCache.delete(mediaPath), 50 * 60 * 1000)
        setState({ url: data.url, error: null })
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return
        setState({ url: null, error: err.message })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [mediaPath])

  return state
}

function DocIcon({ mime, size = 18 }) {
  if (/spreadsheet|excel|csv/i.test(mime || '')) return <FileSpreadsheet size={size} />
  return <FileText size={size} />
}

export default function MediaAttachment({ message, onOpenImage, stamp = null }) {
  const { url, error } = useSignedUrl(message.media_path)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)

  const isImage = message.media_type === 'image'
  const name = message.media_filename || 'Attachment'

  // media_error is the authoritative flag: ingestion failed upstream, so the
  // row records what the attachment was but the bytes never reached our
  // bucket. The missing-path check is only a guard against a malformed row —
  // without it an image would spin on its skeleton forever.
  if (message.media_error || !message.media_path) {
    return (
      <div className="media-error">
        <ImageOff size={15} />
        <span>Media unavailable</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="media-error">
        <ImageOff size={15} />
        <span>Attachment unavailable</span>
      </div>
    )
  }

  if (isImage && !imgFailed) {
    return (
      <button
        type="button"
        className="media-image"
        onClick={() => url && onOpenImage({ url, name })}
        aria-label={`Open image ${name}`}
      >
        {/* Skeleton holds the space until the bytes arrive. */}
        {!imgLoaded ? <span className="media-skeleton" aria-hidden="true" /> : null}
        {url ? (
          <img
            src={url}
            alt={message.media_caption || name}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgFailed(true)}
            style={imgLoaded ? undefined : { visibility: 'hidden', position: 'absolute' }}
          />
        ) : null}
        {/* Timestamp rides on the image over a scrim, so an uncaptioned photo
            costs no extra text line. */}
        {stamp && imgLoaded ? <span className="media-stamp">{stamp}</span> : null}
      </button>
    )
  }

  // Documents — and video/audio, which render as chips by design.
  const TypeIcon =
    message.media_type === 'video' ? Film : message.media_type === 'audio' ? Music : null

  return (
    <a
      className="media-doc"
      href={url || undefined}
      download={name}
      target="_blank"
      rel="noreferrer"
      aria-disabled={!url}
    >
      <span className="media-doc-icon">
        {TypeIcon ? <TypeIcon size={18} /> : <DocIcon mime={message.media_mime} />}
      </span>
      <span className="media-doc-body">
        <span className="media-doc-name">{name}</span>
        <span className="media-doc-meta">
          {formatBytes(message.media_size) || message.media_type}
        </span>
      </span>
      <span className="media-doc-dl">
        <Download size={16} />
      </span>
    </a>
  )
}
