import React, {
  useState,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback
} from 'react'
import { createPortal } from 'react-dom'
import {
  ClipboardPaste,
  ZoomIn,
  ZoomOut,
  Crosshair,
  MousePointer,
  X,
  Type,
  FileImage,
  Layers,
  Pipette,
  Check,
  Camera,
  Mic,
  MicOff
} from 'lucide-react'

// maruAPI / webkitSpeechRecognition の型は src/renderer/src/env.d.ts で宣言済み

// Electron drag region needs a vendor-prefixed CSS property not in React's CSSProperties
type WithDragRegion = React.CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' }

// ─── Color utilities ──────────────────────────────────────────────────────────

type RGB = [number, number, number]

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

/** Median-cut: recursively split into 2^depth buckets, return average of each */
function medianCut(pixels: RGB[], depth: number): RGB[] {
  if (pixels.length === 0) return []
  if (depth === 0) {
    let rs = 0, gs = 0, bs = 0
    for (const [r, g, b] of pixels) { rs += r; gs += g; bs += b }
    const n = pixels.length
    return [[Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)]]
  }
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0
  for (const [r, g, b] of pixels) {
    if (r < rMin) rMin = r; if (r > rMax) rMax = r
    if (g < gMin) gMin = g; if (g > gMax) gMax = g
    if (b < bMin) bMin = b; if (b > bMax) bMax = b
  }
  const rR = rMax - rMin, gR = gMax - gMin, bR = bMax - bMin
  let ch: 0 | 1 | 2 = 0
  if (gR >= rR && gR >= bR) ch = 1
  else if (bR >= rR) ch = 2
  const sorted = [...pixels].sort((a, b_) => a[ch] - b_[ch])
  const mid = Math.floor(sorted.length / 2)
  return [
    ...medianCut(sorted.slice(0, mid), depth - 1),
    ...medianCut(sorted.slice(mid), depth - 1),
  ]
}

/** Extract representative palette (up to 16 colors) from an offscreen canvas */
function extractPaletteFromCanvas(canvas: HTMLCanvasElement): string[] {
  const ctx = canvas.getContext('2d')
  if (!ctx) return []
  const { width, height } = canvas
  const data = ctx.getImageData(0, 0, width, height).data
  // Sample at most ~4096 pixels for performance
  const step = Math.max(1, Math.floor((width * height) / 4096))
  const pixels: RGB[] = []
  for (let i = 0; i < data.length; i += 4 * step) {
    if (data[i + 3] < 128) continue
    pixels.push([data[i], data[i + 1], data[i + 2]])
  }
  if (pixels.length === 0) return []
  const raw = medianCut(pixels, 5)  // 2^5 = 32 candidate colors → ensures ≥10 after dedup
  // De-duplicate: drop colors within Euclidean distance 25 of an already-kept color
  const unique: RGB[] = []
  for (const c of raw) {
    let dup = false
    for (const u of unique) {
      const d = Math.sqrt((c[0] - u[0]) ** 2 + (c[1] - u[1]) ** 2 + (c[2] - u[2]) ** 2)
      if (d < 25) { dup = true; break }
    }
    if (!dup) unique.push(c)
  }
  return unique.map(([r, g, b]) => rgbToHex(r, g, b))
}

// ─── Data model ───────────────────────────────────────────────────────────────

export interface Annotation {
  id: string
  n: number
  kind: 'circle' | 'rect'
  x: number  // image coords: center x for circle, left for rect
  y: number  // image coords: center y for circle, top for rect
  w: number  // rect width (image px); 0 for circle
  h: number  // rect height (image px); 0 for circle
  text: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

// TODO #11: 円密集時の判別性向上 — 現状のガター+L字フォールバックで一旦許容

const CIRCLE_VR = 20       // circle visual radius (screen px)
const BADGE_VR = 9         // badge visual radius (screen px)
const BADGE_FONT_VR = 10   // badge font size (screen px)
const DRAG_MIN_PX = 8      // min screen-px drag to become rect
const MAX_ANNOTATIONS = 20
const RECT_RX = 3          // rounded rect corner radius (image px)
const MARKER_STROKE_W = 2.5  // marker stroke width (screen px)
const HALO_STROKE_W = 5    // halo stroke width (screen px)
const GUTTER_GAP_SCR = 18  // screen px from image edge to gutter badge center

// Adaptive contrast colours
const STROKE_ON_DARK = '#ff40d0'  // hot magenta on dark bg
const STROKE_ON_LIGHT = '#7000cc' // deep purple on light bg
const HALO_ON_DARK = 'rgba(0,0,0,0.65)'
const HALO_ON_LIGHT = 'rgba(255,255,255,0.65)'

/** WCAG 1.4.3 – pick black or white text on badge fill for ≥4.5:1 contrast.
 * #ff40d0 (L≈0.30) → black #000 (6.9:1); #7000cc (L≈0.08) → white #fff (8.2:1) */
function badgeTextFill(fill: string): string {
  return fill === STROKE_ON_DARK ? '#000000' : '#ffffff'
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

interface TooltipProps {
  label: string
  children: React.ReactNode
}

let _tipCounter = 0

function Tooltip({ label, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipIdRef = useRef<string>('')
  if (!tipIdRef.current) tipIdRef.current = `tip-${++_tipCounter}`
  const tipId = tipIdRef.current

  function showTip(): void {
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      setPos({
        top: rect.top - 6,   // will be adjusted via transform
        left: rect.left + rect.width / 2
      })
    }
    setVisible(true)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = React.Children.only(children) as React.ReactElement<any>
  // SC 1.3.1: only reference tipId when the tooltip element is actually in the DOM
  const childWithAria = React.cloneElement(child, { 'aria-describedby': visible ? tipId : undefined })

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={showTip}
      onMouseLeave={() => setVisible(false)}
      onFocus={showTip}
      onBlur={() => setVisible(false)}
      // SC 1.4.13: ESC dismisses tooltip without moving pointer/focus
      onKeyDown={e => { if (e.key === 'Escape') setVisible(false) }}
    >
      {childWithAria}
      {visible && createPortal(
        <div
          id={tipId}
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            transform: 'translate(-50%, -100%)',
            marginTop: -6,
            background: '#3c3c40',
            color: '#e0e0e4',
            fontSize: 11,
            fontWeight: 500,
            padding: '3px 8px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
            // SC 1.4.13: tooltip must be hoverable
            pointerEvents: 'none',
            zIndex: 9999,
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
            border: '1px solid #4a4a50'
          }}
        >
          {label}
        </div>,
        document.body
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

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
          transition: prefersReducedMotion ? undefined : 'background 0.1s, color 0.1s',
          flexShrink: 0
        }}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

// ─── ToolbarDivider ───────────────────────────────────────────────────────────

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
  const [hovered, setHovered] = useState(false)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        height: '100%'
      }}
    >
      <Tooltip label="クリップボードから貼り付け (⌘V)">
        <button
          onClick={onPaste}
          aria-label="クリップボードから貼り付け"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            border: `1.5px dashed ${hovered ? '#5a5a66' : '#3c3c42'}`,
            background: hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: hovered ? '#9090a0' : '#48484e',
            cursor: 'pointer',
            transition: prefersReducedMotion ? undefined : 'border-color 0.15s, color 0.15s, background 0.15s'
          }}
        >
          <ClipboardPaste size={30} strokeWidth={1.4} />
        </button>
      </Tooltip>
      <div style={{ textAlign: 'center', lineHeight: 1.7 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: '#929298', marginBottom: 3 }}>
          画像を貼り付け
        </p>
        <p style={{ fontSize: 11, color: '#9a9aa6' }}>
          ここをクリック または ⌘V
        </p>
      </div>
    </div>
  )
}

// ─── Adaptive contrast helper ─────────────────────────────────────────────────

/** sRGB → linear light (WCAG 2.x relative luminance formula) */
function linearizeSRGB(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** Sample average luminance at 8 points around a circle in image coords */
function sampleLuminanceCircle(
  canvas: HTMLCanvasElement,
  cx: number, cy: number, sampleR: number
): number {
  const ctx = canvas.getContext('2d')
  if (!ctx) return 0.5
  const cw = canvas.width, ch = canvas.height
  let total = 0, count = 0
  for (let deg = 0; deg < 360; deg += 45) {
    const rad = (deg * Math.PI) / 180
    const px = Math.round(cx + sampleR * Math.cos(rad))
    const py = Math.round(cy + sampleR * Math.sin(rad))
    if (px < 0 || py < 0 || px >= cw || py >= ch) continue
    const d = ctx.getImageData(px, py, 1, 1).data
    const r = linearizeSRGB(d[0] / 255)
    const g = linearizeSRGB(d[1] / 255)
    const b = linearizeSRGB(d[2] / 255)
    total += 0.2126 * r + 0.7152 * g + 0.0722 * b
    count++
  }
  return count > 0 ? total / count : 0.5
}

function getAdaptiveColors(
  offscreen: HTMLCanvasElement | null,
  ann: Annotation
): { stroke: string; halo: string } {
  if (!offscreen) return { stroke: STROKE_ON_DARK, halo: HALO_ON_DARK }
  let lum: number
  if (ann.kind === 'circle') {
    lum = sampleLuminanceCircle(offscreen, ann.x, ann.y, 30)
  } else {
    // sample perimeter midpoints using bounding box diagonal
    const cx = ann.x + ann.w / 2
    const cy = ann.y + ann.h / 2
    lum = sampleLuminanceCircle(offscreen, cx, cy, Math.max(ann.w, ann.h) / 2)
  }
  // Threshold at 0.45 relative luminance for WCAG-based contrast split
  if (lum > 0.45) {
    return { stroke: STROKE_ON_LIGHT, halo: HALO_ON_LIGHT }
  }
  return { stroke: STROKE_ON_DARK, halo: HALO_ON_DARK }
}

// ─── Badge placement computation ──────────────────────────────────────────────

/** Computed per-annotation badge placement result */
interface AnnPlacement {
  /** Adjacent badge position in image coords (always computed) */
  adjBx: number
  adjBy: number
  /** Gutter badge position in screen/pane coords (only set when collisions detected) */
  gutterScrBx?: number
  gutterScrBy?: number
  /** L-shaped leader polyline in screen coords [[x,y], ...] */
  leader?: [number, number][]
}

/**
 * Computes badge placements for all annotations.
 * Default: adjacent to figure (image coords).
 * Fallback when any pair of badges collide: gutter mode for all badges.
 * Gutter mode: sort by annotation Y center, 1D interval pack, L-shape leader.
 */
function computeBadgePlacements(
  annotations: Annotation[],
  scale: number,
  ox: number,
  oy: number,
  iw: number
): Map<string, AnnPlacement> {
  const result = new Map<string, AnnPlacement>()
  if (annotations.length === 0) return result

  const br = BADGE_VR / scale

  // Step 1: default adjacent badge positions in image coords
  const adj = annotations.map(ann => {
    let bx: number, by: number
    if (ann.kind === 'circle') {
      const r = CIRCLE_VR / scale
      bx = ann.x + r + br * 0.6
      by = ann.y - r - br * 0.6
    } else {
      bx = ann.x + ann.w + br * 0.6
      by = ann.y - br * 0.6
    }
    return { ann, bx, by }
  })

  // Step 2: collision detection — distance between badge centers in image coords
  const minDistImg = (BADGE_VR * 2 + 4) / scale  // 4 screen-px gap
  let hasCollision = false
  outer: for (let i = 0; i < adj.length; i++) {
    for (let j = i + 1; j < adj.length; j++) {
      const dx = adj[i].bx - adj[j].bx
      const dy = adj[i].by - adj[j].by
      if (Math.sqrt(dx * dx + dy * dy) < minDistImg) {
        hasCollision = true
        break outer
      }
    }
  }

  // Step 3: no collision → adjacent mode for all
  if (!hasCollision) {
    for (const { ann, bx, by } of adj) {
      result.set(ann.id, { adjBx: bx, adjBy: by })
    }
    return result
  }

  // Step 4: gutter mode — determine side and sort Y
  const imgMidScrX = ox + (iw * scale) / 2
  const BADGE_PITCH_SCR = BADGE_VR * 2 + 4  // min vertical pitch in screen px

  const withMeta = adj.map(({ ann, bx, by }) => {
    const annCenterScrX =
      ann.kind === 'circle'
        ? ann.x * scale + ox
        : (ann.x + ann.w / 2) * scale + ox
    const annCenterScrY =
      ann.kind === 'circle'
        ? ann.y * scale + oy
        : (ann.y + ann.h / 2) * scale + oy
    const side: 'left' | 'right' = annCenterScrX < imgMidScrX ? 'left' : 'right'
    return { ann, adjBx: bx, adjBy: by, annCenterScrX, annCenterScrY, side }
  })

  // Clamp left gutter so badge stays inside the pane when ox is near 0 (fit-width)
  const leftGutterScrX = Math.max(BADGE_VR, ox - GUTTER_GAP_SCR)
  const rightGutterScrX = ox + iw * scale + GUTTER_GAP_SCR

  /** 1D interval packing: push badges down if they'd overlap */
  function packGroup(
    group: typeof withMeta,
    gutterScrX: number
  ): Array<{ annId: string; scrBx: number; scrBy: number; leader: [number, number][] }> {
    const sorted = [...group].sort((a, b) => a.annCenterScrY - b.annCenterScrY)
    const isLeft = gutterScrX < imgMidScrX
    let nextMinY = -Infinity

    return sorted.map(p => {
      const desiredY = p.annCenterScrY
      const placedY = Math.max(desiredY, nextMinY)
      nextMinY = placedY + BADGE_PITCH_SCR

      // Figure anchor in screen coords (nearest perimeter point toward the gutter)
      let figScrX: number, figScrY: number
      if (p.ann.kind === 'circle') {
        const r = CIRCLE_VR * scale
        figScrX = isLeft ? p.ann.x * scale + ox - r : p.ann.x * scale + ox + r
        figScrY = p.ann.y * scale + oy
      } else {
        figScrX = isLeft
          ? p.ann.x * scale + ox                     // left edge
          : (p.ann.x + p.ann.w) * scale + ox         // right edge
        figScrY = (p.ann.y + p.ann.h / 2) * scale + oy
      }

      // L-shape: badge → (figScrX, placedY) → figure anchor
      const leader: [number, number][] = [
        [gutterScrX, placedY],
        [figScrX, placedY],
        [figScrX, figScrY]
      ]

      return { annId: p.ann.id, scrBx: gutterScrX, scrBy: placedY, leader }
    })
  }

  const leftPacked = packGroup(withMeta.filter(p => p.side === 'left'), leftGutterScrX)
  const rightPacked = packGroup(withMeta.filter(p => p.side === 'right'), rightGutterScrX)

  const gutterMap = new Map<string, { scrBx: number; scrBy: number; leader: [number, number][] }>()
  for (const r of [...leftPacked, ...rightPacked]) {
    gutterMap.set(r.annId, r)
  }

  for (const { ann, bx, by } of adj) {
    const g = gutterMap.get(ann.id)
    if (g) {
      result.set(ann.id, {
        adjBx: bx, adjBy: by,
        gutterScrBx: g.scrBx, gutterScrBy: g.scrBy,
        leader: g.leader
      })
    } else {
      result.set(ann.id, { adjBx: bx, adjBy: by })
    }
  }

  return result
}

// ─── SVG Annotation shapes ────────────────────────────────────────────────────

interface AnnotationShapeProps {
  ann: Annotation
  scale: number
  offscreen: HTMLCanvasElement | null
  placement: AnnPlacement
}

function AnnotationShape({ ann, scale, offscreen, placement }: AnnotationShapeProps) {
  const { stroke, halo } = getAdaptiveColors(offscreen, ann)
  const sw = MARKER_STROKE_W / scale
  const hw = HALO_STROKE_W / scale
  const br = BADGE_VR / scale
  const bf = BADGE_FONT_VR / scale

  // Badge is only drawn here in adjacent mode (not gutter mode)
  const showBadge = placement.gutterScrBx === undefined
  const { adjBx: bx, adjBy: by } = placement

  return (
    <g>
      {/* Halo + marker */}
      {ann.kind === 'circle' ? (
        <>
          <circle
            cx={ann.x} cy={ann.y} r={CIRCLE_VR / scale}
            fill="none" stroke={halo} strokeWidth={hw}
          />
          <circle
            cx={ann.x} cy={ann.y} r={CIRCLE_VR / scale}
            fill="none" stroke={stroke} strokeWidth={sw}
          />
        </>
      ) : (
        <>
          <rect
            x={ann.x} y={ann.y} width={ann.w} height={ann.h} rx={RECT_RX}
            fill="none" stroke={halo} strokeWidth={hw}
          />
          <rect
            x={ann.x} y={ann.y} width={ann.w} height={ann.h} rx={RECT_RX}
            fill="none" stroke={stroke} strokeWidth={sw}
          />
        </>
      )}

      {/* Adjacent number badge — skipped in gutter mode */}
      {showBadge && (
        <>
          <circle cx={bx} cy={by} r={br} fill={stroke} />
          <text
            x={bx} y={by}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={bf}
            fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
            fontWeight="700"
            fill={badgeTextFill(stroke)}
          >
            {ann.n}
          </text>
        </>
      )}
    </g>
  )
}

// ─── Gutter layer (screen-space badges + L-shape leaders) ────────────────────

interface GutterLayerProps {
  annotations: Annotation[]
  placements: Map<string, AnnPlacement>
}

/** Renders gutter badges and L-shaped leader lines in screen/pane coords.
 * Drawn outside the image-space <g transform> so positions are stable. */
function GutterLayer({ annotations, placements }: GutterLayerProps) {
  const gutterAnns = annotations.filter(
    ann => placements.get(ann.id)?.gutterScrBx !== undefined
  )
  if (gutterAnns.length === 0) return null

  return (
    <g aria-hidden="true">
      {gutterAnns.map(ann => {
        const p = placements.get(ann.id)!
        const bx = p.gutterScrBx!
        const by = p.gutterScrBy!

        return (
          <g key={ann.id}>
            {/* L-shaped leader line */}
            {p.leader && (
              <polyline
                points={p.leader.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none"
                stroke={STROKE_ON_DARK}
                strokeWidth={1.5}
                strokeOpacity={0.65}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {/* Gutter badge: always over dark canvas bg → STROKE_ON_DARK */}
            <circle cx={bx} cy={by} r={BADGE_VR} fill={STROKE_ON_DARK} />
            <text
              x={bx} y={by}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={BADGE_FONT_VR}
              fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
              fontWeight="700"
              fill={badgeTextFill(STROKE_ON_DARK)}
            >
              {ann.n}
            </text>
          </g>
        )
      })}
    </g>
  )
}

// ─── CanvasPane ───────────────────────────────────────────────────────────────

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.05
const ZOOM_MAX = 20

interface CanvasPaneHandle {
  zoomIn(): void
  zoomOut(): void
  getOffscreen(): HTMLCanvasElement | null
}

interface DrawState {
  startImgX: number
  startImgY: number
  curImgX: number
  curImgY: number
  dragging: boolean  // true once drag threshold exceeded
}

interface CanvasPaneProps {
  imageSrc: string | null
  onPaste(): void
  annotations: Annotation[]
  annotationTool: boolean
  onAnnotationsChange(anns: Annotation[]): void
  onAnnotationAdded(n: number): void
  onMaxReached(): void  // #6
  eyedropperTool: boolean
  onPickColor(hex: string): void
  onOffscreenReady(canvas: HTMLCanvasElement): void
}

const CanvasPane = forwardRef<CanvasPaneHandle, CanvasPaneProps>(function CanvasPane(
  {
    imageSrc, onPaste, annotations, annotationTool, onAnnotationsChange, onAnnotationAdded,
    onMaxReached, eyedropperTool, onPickColor, onOffscreenReady
  },
  ref
) {
  const paneRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)

  const scaleRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  const panAnchor = useRef({ mx: 0, my: 0, ox: 0, oy: 0 })

  // Offscreen canvas for adaptive contrast pixel sampling
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  // Image natural size for SVG viewBox
  const imgSizeRef = useRef({ w: 0, h: 0 })

  // Current draw gesture state
  const drawRef = useRef<DrawState | null>(null)
  // Screen-space start for threshold check
  const drawStartScreenRef = useRef({ sx: 0, sy: 0 })
  // Preview rect state (for drag feedback)
  const [preview, setPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // Eyedropper hover state: hex + pane-relative position
  const [eyeHover, setEyeHover] = useState<{ hex: string; px: number; py: number } | null>(null)

  function applyTransform(ns: number, nox: number, noy: number): void {
    scaleRef.current = ns
    offsetRef.current = { x: nox, y: noy }
    setScale(ns)
    setOffset({ x: nox, y: noy })
  }

  // Fit image to pane when a new imageSrc arrives and build offscreen canvas
  useEffect(() => {
    if (!imageSrc || !paneRef.current) return
    const pane = paneRef.current
    const img = new Image()
    img.onload = () => {
      imgSizeRef.current = { w: img.naturalWidth, h: img.naturalHeight }

      // Build offscreen canvas for pixel sampling
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.drawImage(img, 0, 0)
      offscreenRef.current = canvas
      onOffscreenReady(canvas)

      const pw = pane.clientWidth
      const ph = pane.clientHeight
      const fitScale = Math.min(pw / img.naturalWidth, ph / img.naturalHeight, 1)
      const ox = (pw - img.naturalWidth * fitScale) / 2
      const oy = (ph - img.naturalHeight * fitScale) / 2
      applyTransform(fitScale, ox, oy)
    }
    img.src = imageSrc
  }, [imageSrc]) // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel zoom — non-passive to allow preventDefault
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      e.preventDefault()
      // ホイールは小さい刻みで (#2); ボタンズームは ZOOM_STEP=1.25 のまま
      const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06
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

  useImperativeHandle(ref, () => ({
    zoomIn() {
      const pane = paneRef.current
      if (!pane) return
      const prev = scaleRef.current
      const ns = Math.min(prev * ZOOM_STEP, ZOOM_MAX)
      const cx = pane.clientWidth / 2
      const cy = pane.clientHeight / 2
      const off = offsetRef.current
      applyTransform(ns, cx - (cx - off.x) * (ns / prev), cy - (cy - off.y) * (ns / prev))
    },
    zoomOut() {
      const pane = paneRef.current
      if (!pane) return
      const prev = scaleRef.current
      const ns = Math.max(prev / ZOOM_STEP, ZOOM_MIN)
      const cx = pane.clientWidth / 2
      const cy = pane.clientHeight / 2
      const off = offsetRef.current
      applyTransform(ns, cx - (cx - off.x) * (ns / prev), cy - (cy - off.y) * (ns / prev))
    },
    getOffscreen() {
      return offscreenRef.current
    }
  }))

  /** Convert pane-relative screen coords to image coords */
  const screenToImg = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - offsetRef.current.x) / scaleRef.current,
      y: (sy - offsetRef.current.y) / scaleRef.current
    }),
    []
  )

  /** Sample pixel hex at pane-relative screen coords from offscreen canvas */
  function sampleHexAt(sx: number, sy: number): string | null {
    const canvas = offscreenRef.current
    if (!canvas) return null
    const imgX = Math.round((sx - offsetRef.current.x) / scaleRef.current)
    const imgY = Math.round((sy - offsetRef.current.y) / scaleRef.current)
    if (imgX < 0 || imgY < 0 || imgX >= canvas.width || imgY >= canvas.height) return null
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const d = ctx.getImageData(imgX, imgY, 1, 1).data
    return rgbToHex(d[0], d[1], d[2])
  }

  /** Hit-test whether a screen-space click hits an existing annotation */
  function hitAnnotation(sx: number, sy: number): Annotation | null {
    const s = scaleRef.current
    const img = screenToImg(sx, sy)
    const tol = 6 / s  // 6px screen tolerance in image coords
    for (const ann of annotations) {
      if (ann.kind === 'circle') {
        const r = CIRCLE_VR / s
        const dx = img.x - ann.x, dy = img.y - ann.y
        if (dx * dx + dy * dy <= (r + tol) * (r + tol)) return ann
      } else {
        if (
          img.x >= ann.x - tol && img.x <= ann.x + ann.w + tol &&
          img.y >= ann.y - tol && img.y <= ann.y + ann.h + tol
        ) return ann
      }
    }
    return null
  }

  function onMouseDown(e: React.MouseEvent): void {
    if (!imageSrc || e.button !== 0) return
    e.preventDefault()

    if (eyedropperTool) {
      const pane = paneRef.current!
      const rect = pane.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const hex = sampleHexAt(sx, sy)
      if (hex) { onPickColor(hex); setEyeHover(null) }
      return
    }

    if (annotationTool) {
      const pane = paneRef.current!
      const rect = pane.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top

      // Check if clicking an existing annotation → delete
      const hit = hitAnnotation(sx, sy)
      if (hit) {
        const newAnns = annotations
          .filter(a => a.id !== hit.id)
          .map((a, i) => ({ ...a, n: i + 1 }))
        onAnnotationsChange(newAnns)
        return
      }

      // #4: クリック位置が画像範囲外なら注釈開始しない
      const imgClick = screenToImg(sx, sy)
      const { w: imgW, h: imgH } = imgSizeRef.current
      if (imgW > 0 && imgH > 0) {
        if (imgClick.x < 0 || imgClick.x > imgW || imgClick.y < 0 || imgClick.y > imgH) return
      }

      // Start new annotation draw
      drawRef.current = {
        startImgX: imgClick.x, startImgY: imgClick.y,
        curImgX: imgClick.x, curImgY: imgClick.y,
        dragging: false
      }
      drawStartScreenRef.current = { sx, sy }
      return
    }

    // Pan mode
    setIsPanning(true)
    panAnchor.current = {
      mx: e.clientX, my: e.clientY,
      ox: offsetRef.current.x, oy: offsetRef.current.y
    }
  }

  function onMouseMove(e: React.MouseEvent): void {
    const pane = paneRef.current!
    const rect = pane.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    if (eyedropperTool) {
      const hex = sampleHexAt(sx, sy)
      if (hex) setEyeHover({ hex, px: sx, py: sy })
      else setEyeHover(null)
      return
    }

    if (annotationTool && drawRef.current) {
      const img = screenToImg(sx, sy)

      // Check drag threshold in screen space
      const dsx = sx - drawStartScreenRef.current.sx
      const dsy = sy - drawStartScreenRef.current.sy
      const dist = Math.sqrt(dsx * dsx + dsy * dsy)

      drawRef.current = {
        ...drawRef.current,
        curImgX: img.x, curImgY: img.y,
        dragging: dist >= DRAG_MIN_PX
      }

      if (drawRef.current.dragging) {
        const x = Math.min(drawRef.current.startImgX, img.x)
        const y = Math.min(drawRef.current.startImgY, img.y)
        const w = Math.abs(img.x - drawRef.current.startImgX)
        const h = Math.abs(img.y - drawRef.current.startImgY)
        setPreview({ x, y, w, h })
      }
      return
    }

    if (!isPanning) return
    const { mx, my, ox, oy } = panAnchor.current
    const nox = ox + (e.clientX - mx)
    const noy = oy + (e.clientY - my)
    offsetRef.current = { x: nox, y: noy }
    setOffset({ x: nox, y: noy })
  }

  function onMouseUp(e: React.MouseEvent): void {
    if (annotationTool && drawRef.current) {
      const ds = drawRef.current
      drawRef.current = null
      setPreview(null)

      if (annotations.length >= MAX_ANNOTATIONS) {
        onMaxReached()  // #6
        return
      }

      const pane = paneRef.current!
      const rect = pane.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const img = screenToImg(sx, sy)

      const dsx = sx - drawStartScreenRef.current.sx
      const dsy = sy - drawStartScreenRef.current.sy
      const dist = Math.sqrt(dsx * dsx + dsy * dsy)

      const n = annotations.length + 1
      const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

      const { w: imgW, h: imgH } = imgSizeRef.current

      let newAnn: Annotation
      if (!ds.dragging || dist < DRAG_MIN_PX) {
        // Circle — #4: 中心を画像内にクランプ
        const cx = imgW > 0 ? Math.min(Math.max(ds.startImgX, 0), imgW) : ds.startImgX
        const cy = imgH > 0 ? Math.min(Math.max(ds.startImgY, 0), imgH) : ds.startImgY
        newAnn = { id, n, kind: 'circle', x: cx, y: cy, w: 0, h: 0, text: '' }
      } else {
        // Rect — #4: 画像内にクランプ
        let x = Math.min(ds.startImgX, img.x)
        let y = Math.min(ds.startImgY, img.y)
        let w = Math.abs(img.x - ds.startImgX)
        let h = Math.abs(img.y - ds.startImgY)
        if (imgW > 0 && imgH > 0) {
          x = Math.max(0, Math.min(x, imgW))
          y = Math.max(0, Math.min(y, imgH))
          w = Math.min(w, imgW - x)
          h = Math.min(h, imgH - y)
        }
        // Skip degenerate rects
        if (w < 4 || h < 4) return
        newAnn = { id, n, kind: 'rect', x, y, w, h, text: '' }
      }

      onAnnotationsChange([...annotations, newAnn])
      onAnnotationAdded(n)
      return
    }

    setIsPanning(false)
  }

  function stopPan(): void {
    setIsPanning(false)
    setEyeHover(null)
    if (drawRef.current) {
      drawRef.current = null
      setPreview(null)
    }
  }

  const s = scale
  const { x: ox, y: oy } = offset
  const { w: iw, h: ih } = imgSizeRef.current
  const svgTransform = `translate(${ox} ${oy}) scale(${s})`

  // Compute badge placements (adjacent vs gutter) for this render
  const placements =
    imageSrc && iw > 0
      ? computeBadgePlacements(annotations, s, ox, oy, iw)
      : new Map<string, AnnPlacement>()

  // Cursor style
  let cursor = 'default'
  if (imageSrc) {
    if (eyedropperTool) cursor = 'crosshair'
    else if (annotationTool) cursor = 'crosshair'
    else cursor = isPanning ? 'grabbing' : 'grab'
  }

  return (
    <div
      ref={paneRef}
      role="region"
      aria-label="画像キャンバス"
      style={{
        flex: 1,
        minWidth: 0,
        background: '#2b2b2e',
        position: 'relative',
        overflow: 'hidden',
        cursor
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={stopPan}
    >
      {imageSrc ? (
        <>
          <img
            src={imageSrc}
            alt="canvas"
            draggable={false}
            style={{
              position: 'absolute',
              top: 0, left: 0,
              transformOrigin: '0 0',
              transform: `translate(${ox}px, ${oy}px) scale(${s})`,
              maxWidth: 'none', maxHeight: 'none',
              display: 'block',
              userSelect: 'none',
              pointerEvents: 'none'
            }}
          />

          {/* SVG annotation overlay */}
          {iw > 0 && ih > 0 && (
            <svg
              style={{
                position: 'absolute',
                top: 0, left: 0,
                width: '100%', height: '100%',
                overflow: 'visible',
                pointerEvents: 'none'
              }}
              aria-hidden="true"
            >
              {/* Image-space layer: markers + adjacent badges */}
              <g transform={svgTransform}>
                {annotations.map(ann => (
                  <AnnotationShape
                    key={ann.id}
                    ann={ann}
                    scale={s}
                    offscreen={offscreenRef.current}
                    placement={
                      placements.get(ann.id) ?? { adjBx: 0, adjBy: 0 }
                    }
                  />
                ))}

                {/* Drag preview rect */}
                {preview && (
                  <rect
                    x={preview.x} y={preview.y}
                    width={preview.w} height={preview.h}
                    rx={RECT_RX}
                    fill="none"
                    stroke="rgba(255,64,208,0.5)"
                    strokeWidth={2 / s}
                    strokeDasharray={`${6 / s} ${4 / s}`}
                  />
                )}
              </g>

              {/* Screen-space layer: gutter badges + L-shape leaders */}
              <GutterLayer annotations={annotations} placements={placements} />
            </svg>
          )}

          {/* Eyedropper floating preview */}
          {eyedropperTool && eyeHover && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: eyeHover.px + 18,
                top: Math.max(0, eyeHover.py - 36),
                background: '#252527',
                border: '1px solid #3a3a40',
                borderRadius: 6,
                padding: '3px 8px 3px 5px',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                pointerEvents: 'none',
                zIndex: 100,
                fontSize: 11,
                fontFamily: 'monospace',
                color: '#d8d8e0',
                boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
                whiteSpace: 'nowrap'
              }}
            >
              <div
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  background: eyeHover.hex,
                  border: '1px solid rgba(255,255,255,0.2)',
                  flexShrink: 0
                }}
              />
              {eyeHover.hex.toUpperCase()}
            </div>
          )}
        </>
      ) : (
        <CanvasPlaceholder onPaste={onPaste} />
      )}
    </div>
  )
})

// ─── Inspector annotation row ─────────────────────────────────────────────────

interface AnnRowProps {
  ann: Annotation
  textareaRef: (el: HTMLTextAreaElement | null) => void
  onChange: (id: string, text: string) => void
  onDelete: (id: string) => void  // #7
}

function AnnRow({ ann, textareaRef, onChange, onDelete }: AnnRowProps) {
  // #8: 音声入力 (webkitSpeechRecognition は any 型)
  const [listening, setListening] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null)
  const speechAvailable = typeof window !== 'undefined' && 'webkitSpeechRecognition' in window

  function toggleMic(): void {
    if (listening) {
      recRef.current?.stop()
      setListening(false)
      return
    }
    const Rec = window.webkitSpeechRecognition
    const rec = new Rec()
    rec.lang = 'ja-JP'
    rec.interimResults = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (ev: any) => {
      const transcript = ev.results[0][0].transcript as string
      onChange(ann.id, ann.text ? ann.text + ' ' + transcript : transcript)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    rec.start()
    setListening(true)
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 12px',
        borderBottom: '1px solid #282830'
      }}
    >
      {/* Number badge */}
      <div
        style={{
          flexShrink: 0,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: STROKE_ON_DARK,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          color: '#000000',  // WCAG 1.4.3: #000 on #ff40d0 = 6.9:1 ✓
          marginTop: 5,
          letterSpacing: '-0.01em'
        }}
      >
        {ann.n}
      </div>

      {/* Text input */}
      <textarea
        ref={textareaRef}
        value={ann.text}
        onChange={e => onChange(ann.id, e.target.value)}
        aria-label={`注釈 ${ann.n} の修正内容`}
        placeholder={`#${ann.n} の修正内容`}
        rows={2}
        style={{
          flex: 1,
          background: '#1e1e20',
          border: '1px solid #38383e',
          borderRadius: 6,
          color: '#d8d8e0',
          fontSize: 12,
          lineHeight: 1.5,
          padding: '5px 8px',
          resize: 'vertical',
          fontFamily: 'inherit',
          minHeight: 44
        }}
        onFocus={e => {
          e.currentTarget.style.borderColor = '#5a5a66'
          e.currentTarget.style.outline = '2px solid #7070cc'  // WCAG 2.4.7 focus visible
          e.currentTarget.style.outlineOffset = '1px'
        }}
        onBlur={e => {
          e.currentTarget.style.borderColor = '#38383e'
          e.currentTarget.style.outline = 'none'
        }}
      />

      {/* 行右側のアクションボタン群 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        {/* #7: 削除ボタン */}
        <Tooltip label="この注釈を削除">
          <button
            aria-label={`注釈 ${ann.n} を削除`}
            onClick={() => onDelete(ann.id)}
            style={{
              width: 22,
              height: 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: '1px solid #38383e',
              borderRadius: 4,
              color: '#888890',
              cursor: 'pointer',
              padding: 0
            }}
            onMouseEnter={e => {
              e.currentTarget.style.color = '#e07c00'
              e.currentTarget.style.borderColor = '#5a3e00'
              e.currentTarget.style.background = '#2a2000'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = '#888890'
              e.currentTarget.style.borderColor = '#38383e'
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <X size={11} strokeWidth={2} />
          </button>
        </Tooltip>

        {/* #8: 音声入力ボタン */}
        {speechAvailable && (
          <Tooltip label={listening ? '録音停止' : '音声入力'}>
            <button
              aria-label={listening ? '音声入力を停止' : '音声入力を開始'}
              onClick={toggleMic}
              style={{
                width: 22,
                height: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: listening ? '#2a1040' : 'transparent',
                border: `1px solid ${listening ? '#7040c0' : '#38383e'}`,
                borderRadius: 4,
                color: listening ? '#c080ff' : '#888890',
                cursor: 'pointer',
                padding: 0
              }}
              onMouseEnter={e => { if (!listening) e.currentTarget.style.color = '#c8c8d0' }}
              onMouseLeave={e => { if (!listening) e.currentTarget.style.color = '#888890' }}
            >
              {listening ? <MicOff size={11} strokeWidth={2} /> : <Mic size={11} strokeWidth={2} />}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

// ─── Colors panel ─────────────────────────────────────────────────────────────

interface ColorsPanelProps {
  paletteColors: string[]
  pickedColors: string[]
}

function ColorsPanel({ paletteColors, pickedColors }: ColorsPanelProps) {
  const [copiedHex, setCopiedHex] = useState<string | null>(null)
  // SC 4.1.3: live region announces copy completion to screen readers
  const [announcement, setAnnouncement] = useState('')

  function copyHex(hex: string): void {
    window.maruAPI?.writeClipboardText(hex)
    setCopiedHex(hex)
    setAnnouncement(`${hex.toUpperCase()} をコピーしました`)
    setTimeout(() => {
      setCopiedHex(v => v === hex ? null : v)
      setAnnouncement('')
    }, 1500)
  }

  if (paletteColors.length === 0 && pickedColors.length === 0) return null

  return (
    <div
      style={{
        borderTop: '1px solid #2e2e32',
        padding: '10px 14px 12px',
        flexShrink: 0,
        background: '#1e1e22',
        position: 'relative'
      }}
    >
      {/* SC 4.1.3: live region announces copy completion to screen readers */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap'
        }}
      >
        {announcement}
      </div>

      {/* Section header */}
      {/* #5: "Colors" テキスト削除 → Pipette アイコンのみ */}
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: '#909098',
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 6
        }}
      >
        <Pipette size={10} strokeWidth={2} />
      </div>

      {/* Palette swatches */}
      {paletteColors.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {paletteColors.map(hex => (
            <Tooltip key={hex} label={`${hex.toUpperCase()} — クリックでコピー`}>
              <button
                aria-label={`${hex.toUpperCase()} をコピー`}
                onClick={() => copyHex(hex)}
                onFocus={e => { e.currentTarget.style.outline = '2px solid #7070cc'; e.currentTarget.style.outlineOffset = '1px' }}  // WCAG 2.4.7
                onBlur={e => { e.currentTarget.style.outline = 'none' }}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  background: hex,
                  border: copiedHex === hex
                    ? '2px solid #e8e8f0'
                    : '1px solid rgba(255,255,255,0.15)',
                  cursor: 'pointer',
                  padding: 0,
                  flexShrink: 0,
                  boxSizing: 'border-box'
                }}
              />
            </Tooltip>
          ))}
        </div>
      )}

      {/* Picked swatches — eyedropper colors accumulated after palette */}
      {pickedColors.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            marginTop: paletteColors.length > 0 ? 6 : 0,
            paddingTop: paletteColors.length > 0 ? 6 : 0,
            borderTop: paletteColors.length > 0 ? '1px solid #2e2e32' : 'none'
          }}
        >
          {pickedColors.map(hex => (
            <Tooltip key={hex} label={`${hex.toUpperCase()} (スポイト) — クリックでコピー`}>
              <button
                aria-label={`スポイト色 ${hex.toUpperCase()} をコピー`}
                onClick={() => copyHex(hex)}
                onFocus={e => { e.currentTarget.style.outline = '2px solid #7070cc'; e.currentTarget.style.outlineOffset = '1px' }}  // WCAG 2.4.7
                onBlur={e => { e.currentTarget.style.outline = 'none' }}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  background: hex,
                  border: copiedHex === hex
                    ? '2px solid #e8e8f0'
                    : '2px dashed rgba(255,255,255,0.35)',
                  cursor: 'pointer',
                  padding: 0,
                  flexShrink: 0,
                  boxSizing: 'border-box'
                }}
              />
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Export helpers ───────────────────────────────────────────────────────────

/** Unicode circled numbers ①…⑳ (U+2460…U+2473) */
function circledNumber(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCharCode(0x245f + n)
  return `(${n})`
}

/** Build the text output: numbered lines + optional global text */
function buildTextOutput(annotations: Annotation[], globalText: string): string {
  const lines = annotations.map(a => `${circledNumber(a.n)} ${a.text}`)
  if (globalText.trim()) lines.push(`全体: ${globalText}`)
  return lines.join('\n')
}

/** Draw a rounded-rect path on a 2D canvas context (no fill/stroke call — caller does that) */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
): void {
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/** Draw a number badge circle on a 2D canvas context */
function drawBadgeCtx(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number, r: number, n: number, fill: string,
  fontSz: number = BADGE_FONT_VR
): void {
  ctx.beginPath()
  ctx.arc(bx, by, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.font = `700 ${fontSz}px -apple-system, BlinkMacSystemFont, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = badgeTextFill(fill)
  ctx.fillText(String(n), bx, by)
}

/**
 * Render the base image + all annotation markers + adjacent badges onto a new canvas
 * at native image resolution. Returns a PNG data URL.
 */
function buildAnnotatedCanvas(
  imageSrc: string,
  annotations: Annotation[],
  offscreen: HTMLCanvasElement | null
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new globalThis.Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)

      // Scale visual constants from screen-px to image-px (Retina screenshots are 2x)
      const dpr = window.devicePixelRatio || 1
      const circleVR = CIRCLE_VR * dpr
      const badgeVR = BADGE_VR * dpr
      const badgeFontVR = BADGE_FONT_VR * dpr

      for (const ann of annotations) {
        const { stroke, halo } = getAdaptiveColors(offscreen, ann)

        ctx.save()
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'

        if (ann.kind === 'circle') {
          const r = circleVR
          // halo ring
          ctx.beginPath(); ctx.arc(ann.x, ann.y, r, 0, Math.PI * 2)
          ctx.strokeStyle = halo; ctx.lineWidth = HALO_STROKE_W; ctx.stroke()
          // marker ring
          ctx.beginPath(); ctx.arc(ann.x, ann.y, r, 0, Math.PI * 2)
          ctx.strokeStyle = stroke; ctx.lineWidth = MARKER_STROKE_W; ctx.stroke()
          // badge (adjacent: top-right of circle)
          drawBadgeCtx(ctx, ann.x + r + badgeVR * 0.6, ann.y - r - badgeVR * 0.6, badgeVR, ann.n, stroke, badgeFontVR)
        } else {
          // halo rect
          ctx.beginPath(); roundRectPath(ctx, ann.x, ann.y, ann.w, ann.h, RECT_RX)
          ctx.strokeStyle = halo; ctx.lineWidth = HALO_STROKE_W; ctx.stroke()
          // marker rect
          ctx.beginPath(); roundRectPath(ctx, ann.x, ann.y, ann.w, ann.h, RECT_RX)
          ctx.strokeStyle = stroke; ctx.lineWidth = MARKER_STROKE_W; ctx.stroke()
          // badge (adjacent: top-right of rect)
          drawBadgeCtx(ctx, ann.x + ann.w + badgeVR * 0.6, ann.y - badgeVR * 0.6, badgeVR, ann.n, stroke, badgeFontVR)
        }

        ctx.restore()
      }

      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('image load failed'))
    img.src = imageSrc
  })
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [annotationTool, setAnnotationTool] = useState(false)
  const [eyedropperTool, setEyedropperTool] = useState(false)
  const [paletteColors, setPaletteColors] = useState<string[]>([])
  const [pickedColors, setPickedColors] = useState<string[]>([])
  const [globalText, setGlobalText] = useState('')
  const canvasPaneRef = useRef<CanvasPaneHandle>(null)

  // Refs for inspector text inputs (for auto-focus)
  const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([])
  const [pendingFocusN, setPendingFocusN] = useState<number | null>(null)
  const inspectorScrollRef = useRef<HTMLDivElement>(null)

  // #6: 上限トースト
  const [maxReached, setMaxReached] = useState(false)
  const maxReachedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showMaxReached(): void {
    setMaxReached(true)
    if (maxReachedTimerRef.current) clearTimeout(maxReachedTimerRef.current)
    maxReachedTimerRef.current = setTimeout(() => setMaxReached(false), 2000)
  }

  // #3: コピーボタンのフィードバック状態
  const [copiedKind, setCopiedKind] = useState<'text' | 'image' | 'all' | null>(null)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function triggerCopyFeedback(kind: 'text' | 'image' | 'all'): void {
    setCopiedKind(kind)
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    copyFeedbackTimerRef.current = setTimeout(() => setCopiedKind(null), 1500)
  }

  // ─── Copy handlers ──────────────────────────────────────────────────────────

  function handleCopyText(): void {
    const text = buildTextOutput(annotations, globalText)
    window.maruAPI?.writeClipboardText(text)
    triggerCopyFeedback('text')  // #3
  }

  async function handleCopyImage(): Promise<void> {
    if (!imageSrc) return
    const offscreen = canvasPaneRef.current?.getOffscreen() ?? null
    const dataUrl = await buildAnnotatedCanvas(imageSrc, annotations, offscreen)
    window.maruAPI?.writeClipboardImage(dataUrl)
    triggerCopyFeedback('image')  // #3
  }

  async function handleCopyAll(): Promise<void> {
    if (!imageSrc) return
    const offscreen = canvasPaneRef.current?.getOffscreen() ?? null
    const dataUrl = await buildAnnotatedCanvas(imageSrc, annotations, offscreen)
    const text = buildTextOutput(annotations, globalText)
    window.maruAPI?.writeClipboardBoth(dataUrl, text)
    triggerCopyFeedback('all')  // #3
  }

  function handlePaste(): void {
    const src = window.maruAPI?.readClipboardImage?.()
    if (src) {
      setImageSrc(src)
      setAnnotations([])
      setPaletteColors([])
      setPickedColors([])
    }
  }

  // #7: 注釈個別削除（採番詰め直し）
  function handleDeleteAnnotation(id: string): void {
    setAnnotations(prev =>
      prev.filter(a => a.id !== id).map((a, i) => ({ ...a, n: i + 1 }))
    )
  }

  // #9: スクショキャプチャ → クリップボード → 新窓に自動貼り付け
  async function handleCapture(): Promise<void> {
    await window.maruAPI?.captureScreen()
    // autoLoad=true: 新窓のロード完了後に main が auto-paste IPC を送信し自動ペーストされる
    await window.maruAPI?.createNewWindow(true)
  }

  // ⌘V / ⌘N global keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      // textarea / input へのテキスト貼付と競合しないようフォーカス先を確認
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') handlePaste()
      // #10: ⌘N で新規ウィンドウ
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        void window.maruAPI?.createNewWindow()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // #9: main プロセスからの auto-paste イベントを受けてクリップボード画像を自動ロード
  useEffect(() => {
    const unregister = window.maruAPI?.onAutoPaste(() => { handlePaste() })
    return () => unregister?.()
  }, [])

  // Auto-focus the newly added annotation's text input
  useEffect(() => {
    if (pendingFocusN === null) return
    const idx = annotations.findIndex(a => a.n === pendingFocusN)
    if (idx >= 0) {
      const el = textareaRefs.current[idx]
      if (el) {
        el.focus()
        el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion ? 'instant' : 'smooth' })
      }
    }
    setPendingFocusN(null)
  }, [pendingFocusN, annotations])

  function handleAnnotationTextChange(id: string, text: string): void {
    setAnnotations(prev => prev.map(a => a.id === id ? { ...a, text } : a))
  }

  const handleOffscreenReady = useCallback((canvas: HTMLCanvasElement): void => {
    setPaletteColors(extractPaletteFromCanvas(canvas))
    setPickedColors([])
  }, [])

  function toggleAnnotationTool(): void {
    if (!imageSrc) return
    setAnnotationTool(v => !v)
    setEyedropperTool(false)
  }

  function toggleEyedropperTool(): void {
    if (!imageSrc) return
    setEyedropperTool(v => !v)
    setAnnotationTool(false)
  }

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
      {/* ── Title bar ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 44,
          background: '#252527',
          borderBottom: '1px solid #2e2e32',
          flexShrink: 0,
          position: 'relative',
          WebkitAppRegion: 'drag'
        } as WithDragRegion}
      >
        {/* macOS traffic light spacer */}
        <div style={{ width: 72, flexShrink: 0 }} />

        {/* App name — absolutely centered */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            textAlign: 'center',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.08em',
            color: '#64646e',
            pointerEvents: 'none'
          }}
          aria-hidden="true"
        >
          maru
        </div>

        {/* Export buttons — right side */}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 12px',
            WebkitAppRegion: 'no-drag'
          } as WithDragRegion}
        >
          <IconButton
            icon={copiedKind === 'text' ? <Check size={15} strokeWidth={2.5} /> : <Type size={15} strokeWidth={1.8} />}
            label="テキストのみコピー"
            onClick={handleCopyText}
            active={copiedKind === 'text'}
            disabled={!imageSrc}
          />
          <IconButton
            icon={copiedKind === 'image' ? <Check size={15} strokeWidth={2.5} /> : <FileImage size={15} strokeWidth={1.8} />}
            label="注釈付き画像をコピー"
            onClick={() => { void handleCopyImage() }}
            active={copiedKind === 'image'}
            disabled={!imageSrc}
          />
          <IconButton
            icon={copiedKind === 'all' ? <Check size={15} strokeWidth={2.5} /> : <Layers size={15} strokeWidth={1.8} />}
            label="画像+テキストをコピー"
            onClick={() => { void handleCopyAll() }}
            active={copiedKind === 'all'}
            disabled={!imageSrc}
          />
        </div>
      </div>

      {/* ── Main area ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Canvas area wrapper — relative for floating toolbar */}
        <div style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
          <CanvasPane
            ref={canvasPaneRef}
            imageSrc={imageSrc}
            onPaste={handlePaste}
            annotations={annotations}
            annotationTool={annotationTool}
            onAnnotationsChange={setAnnotations}
            onAnnotationAdded={n => setPendingFocusN(n)}
            onMaxReached={showMaxReached}
            eyedropperTool={eyedropperTool}
            onPickColor={hex => {
              const lower = hex.toLowerCase()
              if (![...paletteColors, ...pickedColors].some(c => c.toLowerCase() === lower)) {
                setPickedColors(prev => [...prev, hex])
              }
              window.maruAPI?.writeClipboardText(hex)
            }}
            onOffscreenReady={handleOffscreenReady}
          />

          {/* ── Floating toolbar (Figma-style, canvas bottom center) ── */}
          <div
            style={{
              position: 'absolute',
              bottom: 20,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              padding: '0 8px',
              height: 44,
              background: '#252527',
              border: '1px solid #3a3a40',
              borderRadius: 10,
              boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
              zIndex: 100,
              pointerEvents: 'auto'
            }}
          >
            <IconButton
              icon={<ClipboardPaste size={15} strokeWidth={1.8} />}
              label="クリップボードから貼り付け (⌘V)"
              onClick={handlePaste}
            />

            <ToolbarDivider />

            <IconButton
              icon={<MousePointer size={15} strokeWidth={1.8} />}
              label="選択 / パン (V)"
              onClick={() => { setAnnotationTool(false); setEyedropperTool(false) }}
              active={!annotationTool && !eyedropperTool}
            />
            <IconButton
              icon={<Crosshair size={15} strokeWidth={1.8} />}
              label={annotationTool ? '注釈ツール ON — クリック=円 / ドラッグ=矩形 / 再クリック=削除' : '注釈ツール (A)'}
              onClick={toggleAnnotationTool}
              active={annotationTool}
              disabled={!imageSrc}
            />
            <IconButton
              icon={<Pipette size={15} strokeWidth={1.8} />}
              label={eyedropperTool ? 'スポイト ON — クリックで色取得' : 'スポイト (I)'}
              onClick={toggleEyedropperTool}
              active={eyedropperTool}
              disabled={!imageSrc}
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

            {/* スクリーンキャプチャ */}
            <IconButton
              icon={<Camera size={15} strokeWidth={1.8} />}
              label="スクリーンショットを撮影して新規ウィンドウに開く"
              onClick={() => { void handleCapture() }}
            />
          </div>
        </div>

        {/* Divider */}
        <div style={{ width: 1, background: '#2e2e32', flexShrink: 0 }} />

        {/* Inspector pane */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            background: '#232325',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          {/* Inspector header */}
          <div
            style={{
              padding: '8px 10px 8px 14px',
              borderBottom: '1px solid #2e2e32',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: '#a0a0a8',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              flexShrink: 0
            }}
          >
            {/* 上限到達トースト */}
            {maxReached && (
              <span style={{ fontSize: 10, color: '#e07c00', fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>
                これ以上追加できません（最大{MAX_ANNOTATIONS}）
              </span>
            )}
          </div>

          {/* Annotation rows */}
          <div
            ref={inspectorScrollRef}
            style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}
          >
            {annotations.length === 0 ? (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#55555e',
                  fontSize: 12,
                  flexDirection: 'column',
                  gap: 8
                }}
              >
                <Crosshair size={22} strokeWidth={1.2} color="#38383e" />
                <span style={{ color: '#909098' }}>注釈を追加すると入力欄が現れます</span>
              </div>
            ) : (
              <>
                {annotations.map((ann, idx) => (
                  <AnnRow
                    key={ann.id}
                    ann={ann}
                    textareaRef={el => { textareaRefs.current[idx] = el }}
                    onChange={handleAnnotationTextChange}
                    onDelete={handleDeleteAnnotation}
                  />
                ))}

                {/* Clear-all button when annotations present */}
                <div style={{ padding: '8px 14px' }}>
                  <Tooltip label="全注釈を削除">
                    <button
                      aria-label="全注釈を削除"
                      onClick={() => setAnnotations([])}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 28,
                        height: 28,
                        background: 'transparent',
                        border: '1px solid #38383e',
                        borderRadius: 6,
                        color: '#909098',  // SC 1.4.3: ≥4.5:1 on #232325 (4.95:1) ✓
                        cursor: 'pointer',
                        padding: 0
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.borderColor = '#5a3e00'
                        e.currentTarget.style.color = '#e07c00'  // amber: CVD-safe, not red/green
                        e.currentTarget.style.background = '#2a2000'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = '#38383e'
                        e.currentTarget.style.color = '#909098'
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <X size={13} strokeWidth={2} />
                    </button>
                  </Tooltip>
                </div>
              </>
            )}
          </div>

          {/* Colors section */}
          <ColorsPanel paletteColors={paletteColors} pickedColors={pickedColors} />

          {/* Global text section — always visible at inspector bottom */}
          <div
            style={{
              borderTop: '1px solid #2e2e32',
              padding: '10px 14px 12px',
              flexShrink: 0,
              background: '#1e1e22'
            }}
          >
            <label
              htmlFor="global-text"
              style={{
                display: 'block',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: '#909098',  // SC 1.4.3: ≥4.5:1 on #1e1e22 (4.95:1) ✓
                marginBottom: 6
              }}
            >
              全体コメント
            </label>
            <textarea
              id="global-text"
              value={globalText}
              onChange={e => setGlobalText(e.target.value)}
              aria-label="全体コメント"
              placeholder="画像全体への補足・コンテキスト"
              rows={3}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: '#1e1e20',
                border: '1px solid #38383e',
                borderRadius: 6,
                color: '#d8d8e0',
                fontSize: 12,
                lineHeight: 1.5,
                padding: '5px 8px',
                resize: 'vertical',
                fontFamily: 'inherit',
                minHeight: 56
              }}
              onFocus={e => {
                e.currentTarget.style.borderColor = '#5a5a66'
                e.currentTarget.style.outline = '2px solid #7070cc'
                e.currentTarget.style.outlineOffset = '1px'
              }}
              onBlur={e => {
                e.currentTarget.style.borderColor = '#38383e'
                e.currentTarget.style.outline = 'none'
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
