import React, { useState, useRef } from 'react'
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
      <button
        onClick={onPaste}
        aria-label="クリップボードから貼り付け"
        style={{
          marginTop: 4,
          padding: '6px 16px',
          background: '#2e2e34',
          border: '1px solid #3e3e46',
          borderRadius: 6,
          color: '#9090a0',
          fontSize: 12,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6
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
        <ClipboardPaste size={13} strokeWidth={1.5} />
        貼り付け
      </button>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [activeToolRef] = [useRef<string>('select')]
  void activeToolRef // scaffold – tools wired in Phase 3

  function handlePaste() {
    const src = window.maruAPI?.readClipboardImage?.()
    if (src) setImageSrc(src)
  }

  // ⌘V global keyboard shortcut
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
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
            label="ズームイン (Phase 2)"
            disabled
          />
          <IconButton
            icon={<ZoomOut size={15} strokeWidth={1.8} />}
            label="ズームアウト (Phase 2)"
            disabled
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
        <div
          style={{
            flex: '0 0 65%',
            background: '#2b2b2e',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {imageSrc ? (
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <img
                src={imageSrc}
                alt="canvas"
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  display: 'block',
                  objectFit: 'contain'
                }}
              />
            </div>
          ) : (
            <CanvasPlaceholder onPaste={handlePaste} />
          )}
        </div>

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
