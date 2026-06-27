import React, {
  useState,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle
} from 'react'
import {
  ClipboardPaste,
  ZoomIn,
  ZoomOut,
  Circle,
  RectangleHorizontal,
  Copy,
  Minus
} from 'lucide-react'

// Electron drag region needs a vendor-prefixed CSS property not in React's CSSProperties
type WithDragRegion = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' }

// ─── Tooltip ──────────────────────────────────────────────────────────────────

interface TooltipProps {
  label: string
  children: React.ReactNode
}

function Tooltip({ label, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  return (
    <div
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#3c3c40',
            color: '#e0e0e4',
            fontSize: 11,
            fontWeight: 500,
            padding: '3px 8px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 200,
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            border: '1px solid #4a4a50'
          }}
        >
          {label}
        </div>
      )}
    </div>
  )
}

// ─── IconButton ────────────────────────────────────────────────────────────────

interface IconButtonProps {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
}

function IconButton({ icon, label, onClick, active = false, disabled = false }: IconButtonProps) {
  const [hovered, setHovered] = useState(false)
  return (
    <Tooltip label={label}>
      <button
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          background: active ? '#4a4a52' : hovered ? '#3a3a3e' : 'transparent',
          border: active ? '1px solid #5c5c66' : '1px solid transparent',
          borderRadius: 6,
          cursor: disabled ? 'default' : 'pointer',
          color: disabled ? '#55555a' : active ? '#e8e8f0' : hovered ? '#c8c8d0' : '#888890',
          transition: 'background 0.1s, color 0.1s',
          flexShrink: 0
        }}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

// ─── Divider ──────────────────────────────────────────────────────────────────

function ToolbarDivider() {
  return (
    <div
      style={{
        width: 1,
        height: 20,
        background: '#3a3a3e',
        margin: '0 4px',
        flexShrink: 0
      }}
    />
  )
}

// ─── CanvasPlaceholder ────────────────────────────────────────────────────────

function CanvasPlaceholder({ onPaste }: { onPaste: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        height: '100%',
        color: '#55555e'
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          border: '1.5px dashed #3a3a40',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#44444c'
        }}
      >
        <ClipboardPaste size={28} strokeWidth={1.5} />
      </div>
      <div style={{ textAlign: 'center', lineHeight: 1.6 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: '#606068', marginBottom: 4 }}>
          画像を貼り付け
        </p>
        <p style={{ fontSize: 11, color: '#484850' }}>
          ツールバーのボタン または ⌘V
        </p>
      </div>
      <Tooltip label="クリップボードから貼り付け (⌘V)">
        <button
          onClick={onPaste}
          aria-label="クリップボードから貼り付け"
          style={{
            marginTop: 4,
            width: 36,
            height: 36,
            background: '#2e2e34',
            border: '1px solid #3e3e46',
            borderRadius: 8,
            color: '#9090a0',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = '#38383f'
            e.currentTarget.style.color = '#c0c0cc'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = '#2e2e34'
            e.currentTarget.style.color = '#9090a0'
          }}
        >
          <ClipboardPaste size={15} strokeWidth={1.5} />
        </button>
      </Tooltip>
    </div>
  )
}

// ─── CanvasPane ───────────────────────────────────────────────────────────────

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.05
const ZOOM_MAX = 20

interface CanvasPaneHandle {
  zoomIn(): void
  zoomOut(): void
}

interface CanvasPaneProps {
  imageSrc: string | null
  onPaste(): void
}

const CanvasPane = forwardRef<CanvasPaneHandle, CanvasPaneProps>(function CanvasPane(
  { imageSrc, onPaste },
  ref
) {
  const paneRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)

  // Mutable refs to read current values inside addEventListener callbacks
  // (avoids stale-closure issues with passive wheel handler)
  const scaleRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  const panAnchor = useRef({ mx: 0, my: 0, ox: 0, oy: 0 })

  function applyTransform(ns: number, nox: number, noy: number): void {
    scaleRef.current = ns
    offsetRef.current = { x: nox, y: noy }
    setScale(ns)
    setOffset({ x: nox, y: noy })
  }

  // Fit image to pane when a new imageSrc arrives
  useEffect(() => {
    if (!imageSrc || !paneRef.current) return
    const pane = paneRef.current
    const img = new Image()
    img.onload = () => {
      const pw = pane.clientWidth
      const ph = pane.clientHeight
      const fitScale = Math.min(pw / img.naturalWidth, ph / img.naturalHeight, 1)
      const ox = (pw - img.naturalWidth * fitScale) / 2
      const oy = (ph - img.naturalHeight * fitScale) / 2
      applyTransform(fitScale, ox, oy)
    }
    img.src = imageSrc
  }, [imageSrc])

  // Wheel zoom centred on cursor — must be non-passive to allow preventDefault
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      e.preventDefault()
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const prev = scaleRef.current
      const ns = Math.min(Math.max(prev * factor, ZOOM_MIN), ZOOM_MAX)
      const rect = el!.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const off = offsetRef.current
      applyTransform(
        ns,
        cx - (cx - off.x) * (ns / prev),
        cy - (cy - off.y) * (ns / prev)
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Expose zoomIn / zoomOut to toolbar buttons in parent
  useImperativeHandle(ref, () => ({
    zoomIn() {
      const pane = paneRef.current
      if (!pane) return
      const prev = scaleRef.current
      const ns = Math.min(prev * ZOOM_STEP, ZOOM_MAX)
      const cx = pane.clientWidth / 2
      const cy = pane.clientHeight / 2
      const off = offsetRef.current
      applyTransform(
        ns,
        cx - (cx - off.x) * (ns / prev),
        cy - (cy - off.y) * (ns / prev)
      )
    },
    zoomOut() {
      const pane = paneRef.current
      if (!pane) return
      const prev = scaleRef.current
      const ns = Math.max(prev / ZOOM_STEP, ZOOM_MIN)
      const cx = pane.clientWidth / 2
      const cy = pane.clientHeight / 2
      const off = offsetRef.current
      applyTransform(
        ns,
        cx - (cx - off.x) * (ns / prev),
        cy - (cy - off.y) * (ns / prev)
      )
    }
  }))

  function onMouseDown(e: React.MouseEvent): void {
    if (!imageSrc || e.button !== 0) return
    e.preventDefault()
    setIsPanning(true)
    panAnchor.current = {
      mx: e.clientX,
      my: e.clientY,
      ox: offsetRef.current.x,
      oy: offsetRef.current.y
    }
  }

  function onMouseMove(e: React.MouseEvent): void {
    if (!isPanning) return
    const { mx, my, ox, oy } = panAnchor.current
    const nox = ox + (e.clientX - mx)
    const noy = oy + (e.clientY - my)
    offsetRef.current = { x: nox, y: noy }
    setOffset({ x: nox, y: noy })
  }

  function stopPan(): void {
    setIsPanning(false)
  }

  return (
    <div
      ref={paneRef}
      style={{
        flex: '0 0 65%',
        background: '#2b2b2e',
        position: 'relative',
        overflow: 'hidden',
        cursor: imageSrc ? (isPanning ? 'grabbing' : 'grab') : 'default'
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={stopPan}
      onMouseLeave={stopPan}
    >
      {imageSrc ? (
        <img
          src={imageSrc}
          alt="canvas"
          draggable={false}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transformOrigin: '0 0',
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            maxWidth: 'none',
            maxHeight: 'none',
            display: 'block',
            userSelect: 'none',
            // Prevent image from consuming pointer events so pan drag is captured by pane
            pointerEvents: 'none'
          }}
        />
      ) : (
        <CanvasPlaceholder onPaste={onPaste} />
      )}
    </div>
  )
})

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const canvasPaneRef = useRef<CanvasPaneHandle>(null)

  function handlePaste(): void {
    const src = window.maruAPI?.readClipboardImage?.()
    if (src) setImageSrc(src)
  }

  // ⌘V global keyboard shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        handlePaste()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: '#1e1e20',
        color: '#e0e0e4'
      }}
    >
      {/* ── Toolbar ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '0 12px',
          height: 44,
          background: '#252527',
          borderBottom: '1px solid #2e2e32',
          flexShrink: 0,
          WebkitAppRegion: 'drag'
        } as WithDragRegion}
      >
        {/* Traffic-light spacer on macOS hiddenInset */}
        <div style={{ width: 72, flexShrink: 0 }} />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            WebkitAppRegion: 'no-drag'
          } as WithDragRegion}
        >
          <IconButton
            icon={<ClipboardPaste size={15} strokeWidth={1.8} />}
            label="クリップボードから貼り付け (⌘V)"
            onClick={handlePaste}
          />

          <ToolbarDivider />

          <IconButton
            icon={<Circle size={15} strokeWidth={1.8} />}
            label="円マーカー (Phase 3)"
            disabled
          />
          <IconButton
            icon={<RectangleHorizontal size={15} strokeWidth={1.8} />}
            label="矩形マーカー (Phase 3)"
            disabled
          />

          <ToolbarDivider />

          <IconButton
            icon={<ZoomIn size={15} strokeWidth={1.8} />}
            label="ズームイン"
            onClick={() => canvasPaneRef.current?.zoomIn()}
            disabled={!imageSrc}
          />
          <IconButton
            icon={<ZoomOut size={15} strokeWidth={1.8} />}
            label="ズームアウト"
            onClick={() => canvasPaneRef.current?.zoomOut()}
            disabled={!imageSrc}
          />

          <ToolbarDivider />

          <IconButton
            icon={<Copy size={15} strokeWidth={1.8} />}
            label="コピー (Phase 5)"
            disabled
          />
        </div>

        {/* App name – center */}
        <div
          style={{
            flex: 1,
            textAlign: 'center',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: '#585860',
            pointerEvents: 'none'
          }}
        >
          maru
        </div>

        {/* Right spacer to balance traffic-light side */}
        <div style={{ width: 72, flexShrink: 0 }} />
      </div>

      {/* ── Main area ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Canvas pane */}
        <CanvasPane ref={canvasPaneRef} imageSrc={imageSrc} onPaste={handlePaste} />

        {/* Divider */}
        <div
          style={{
            width: 1,
            background: '#2e2e32',
            flexShrink: 0
          }}
        />

        {/* Inspector pane */}
        <div
          style={{
            flex: 1,
            background: '#232325',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          {/* Inspector header */}
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid #2e2e32',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: '#505058',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <Minus size={10} strokeWidth={2} />
            Inspector
          </div>

          {/* Empty state */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#404048',
              fontSize: 12
            }}
          >
            注釈を追加すると入力欄が現れます
          </div>
        </div>
      </div>
    </div>
  )
}
