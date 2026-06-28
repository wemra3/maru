import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  forwardRef,
  useImperativeHandle,
  useCallback
} from 'react'
import { createPortal } from 'react-dom'
import {
  ClipboardPaste,
  ZoomIn,
  ZoomOut,
  Circle,
  MousePointer,
  X,
  Trash2,
  Type,
  FileImage,
  Layers,
  Pipette,
  Check,
  Camera
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

/** RGB(0-255) → HSL (h:0-360, s/l:0-1) */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h * 60, s, l]
}

/** Extract representative palette from an offscreen canvas: dominant (area) + accent (vivid) colors */
function extractPaletteFromCanvas(canvas: HTMLCanvasElement): string[] {
  const ctx = canvas.getContext('2d')
  if (!ctx) return []
  const { width, height } = canvas
  const data = ctx.getImageData(0, 0, width, height).data
  // Dense sampling (~60k px) so small but important accents (status dots, badges) are caught
  const step = Math.max(1, Math.floor((width * height) / 60000))
  const pixels: RGB[] = []
  for (let i = 0; i < data.length; i += 4 * step) {
    if (data[i + 3] < 128) continue
    pixels.push([data[i], data[i + 1], data[i + 2]])
  }
  if (pixels.length === 0) return []

  // Dominant (neutral/background) colors by area
  const dominants = medianCut(pixels, 3)  // up to 8 — backgrounds/neutrals

  // Accent colors: among VIVID pixels only (white/grey bg excluded), pick the best color
  // PER HUE FAMILY so minority hues (green/orange status colors) aren't crowded out by the
  // dominant brand hue. Score = frequency × saturation, so small-but-vivid badges still win.
  const vivid = new Map<string, { rgb: RGB; count: number; hue: number; sat: number }>()
  for (const [r, g, b] of pixels) {
    const [h, s, l] = rgbToHsl(r, g, b)
    if (s < 0.25 || l < 0.12 || l > 0.94) continue  // skip neutrals / near-white / near-black
    const key = `${r >> 4},${g >> 4},${b >> 4}`  // quantize to 16-step grid
    const cur = vivid.get(key)
    if (cur) { cur.count++ } else { vivid.set(key, { rgb: [r, g, b], count: 1, hue: h, sat: s }) }
  }
  const HUE_BUCKETS = 12
  const bestPerHue = new Map<number, { rgb: RGB; sat: number; prom: number }>()
  for (const v of vivid.values()) {
    if (v.count < 3) continue
    const hb = Math.floor((v.hue / 360) * HUE_BUCKETS) % HUE_BUCKETS
    const cur = bestPerHue.get(hb)
    // Pick the MOST SATURATED color per hue family — the punchy brand/status color,
    // not the large pale background tint of the same hue.
    if (!cur || v.sat > cur.sat) bestPerHue.set(hb, { rgb: v.rgb, sat: v.sat, prom: v.count * v.sat })
  }
  const accents = [...bestPerHue.values()]
    .sort((a, b) => b.prom - a.prom)  // most prominent (area×saturation) first → brand primary leads
    .map(v => v.rgb)

  // Accents first (design-relevant) then neutrals; de-dup by Euclidean distance, cap 16
  const unique: RGB[] = []
  for (const c of [...accents, ...dominants]) {
    let dup = false
    for (const u of unique) {
      const d = Math.sqrt((c[0] - u[0]) ** 2 + (c[1] - u[1]) ** 2 + (c[2] - u[2]) ** 2)
      if (d < 20) { dup = true; break }
    }
    if (!dup) unique.push(c)
    if (unique.length >= 16) break
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
  // pos.top = anchor for "above" mode (rect.top); pos.bottom = anchor for "below" mode (rect.bottom)
  const [pos, setPos] = useState({ top: 0, bottom: 0, left: 0 })
  // Horizontal correction so tooltip never bleeds off viewport edge
  const [clampDx, setClampDx] = useState(0)
  // Vertical flip: true → show tooltip below the trigger element
  const [flipDown, setFlipDown] = useState(false)
  const tipElRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipIdRef = useRef<string>('')
  if (!tipIdRef.current) tipIdRef.current = `tip-${++_tipCounter}`
  const tipId = tipIdRef.current

  function showTip(): void {
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      setPos({
        top: rect.top - 6,
        bottom: rect.bottom + 6,
        left: rect.left + rect.width / 2
      })
      setClampDx(0)
      setFlipDown(false)
    }
    setVisible(true)
  }

  // After tooltip mounts: vertical flip when off top edge, then horizontal clamp (Fix #9)
  useLayoutEffect(() => {
    if (!visible || !tipElRef.current) return
    const tipRect = tipElRef.current.getBoundingClientRect()
    const vw = window.innerWidth
    const edgeMargin = 8  // min clearance from any viewport edge (vertical flip + horizontal clamp)

    // Vertical flip: if tooltip top would be above viewport, flip to show below trigger
    if (!flipDown && tipRect.top < edgeMargin) {
      setFlipDown(true)
      return  // Re-measure after flip to get correct horizontal position
    }

    // Horizontal clamp (works for both above and below orientation)
    let dx = 0
    if (tipRect.right > vw - edgeMargin) dx = (vw - edgeMargin) - tipRect.right
    if (tipRect.left < edgeMargin) dx = edgeMargin - tipRect.left
    if (Math.abs(dx) > 0.5) setClampDx(dx)
  }, [visible, pos, flipDown])

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
          ref={tipElRef}
          id={tipId}
          role="tooltip"
          style={{
            position: 'fixed',
            top: flipDown ? pos.bottom : pos.top,
            left: pos.left + clampDx,
            // Above: shift up by full tooltip height. Below: no vertical shift.
            transform: flipDown ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            marginTop: flipDown ? 0 : -6,
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

// ─── AnnotationToolIcon (custom SVG: ◯ with 1 inside) ───────────────────────

/** Numbered circle icon: circle ring with "1" centred — recognisable stamp tool */
function AnnotationToolIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        dy="-0.07em"
        fontSize="13"
        fontWeight="600"
        fontFamily="system-ui, -apple-system, sans-serif"
        fill="currentColor"
      >
        1
      </text>
    </svg>
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
      <Tooltip label="Paste from clipboard (⌘V)">
        <button
          onClick={onPaste}
          aria-label="Paste from clipboard"
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
          Paste image
        </p>
        <p style={{ fontSize: 11, color: '#9a9aa6' }}>
          Click here or ⌘V
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
  isNew?: boolean
}

function AnnotationShape({ ann, scale, offscreen, placement, isNew = false }: AnnotationShapeProps) {
  const { stroke, halo } = getAdaptiveColors(offscreen, ann)
  const sw = MARKER_STROKE_W / scale
  const hw = HALO_STROKE_W / scale
  const br = BADGE_VR / scale
  const bf = BADGE_FONT_VR / scale

  // Badge is only drawn here in adjacent mode (not gutter mode)
  const showBadge = placement.gutterScrBx === undefined
  const { adjBx: bx, adjBy: by } = placement

  // Pop animation: subtle scale-in, no overshoot
  const popStyle = isNew && !prefersReducedMotion ? ({
    transformBox: 'fill-box',
    transformOrigin: '50% 50%',
    animation: 'ann-pop 0.14s ease-out forwards'
  } as React.CSSProperties) : undefined

  // Ripple animation: minimal ring expansion
  const rippleStyle = {
    transformBox: 'fill-box',
    transformOrigin: '50% 50%',
    animation: 'ann-ripple 0.25s ease-out forwards',
    pointerEvents: 'none' as const
  } as React.CSSProperties

  return (
    <g>
      {/* Pop animation wrapper around halo + marker */}
      <g style={popStyle}>
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
      </g>

      {/* Ripple ring — expands and fades on stamp placement */}
      {isNew && !prefersReducedMotion && (
        ann.kind === 'circle' ? (
          <circle
            cx={ann.x} cy={ann.y} r={CIRCLE_VR / scale}
            fill="none" stroke={stroke} strokeWidth={sw}
            style={rippleStyle}
          />
        ) : (
          <rect
            x={ann.x} y={ann.y} width={ann.w} height={ann.h} rx={RECT_RX}
            fill="none" stroke={stroke} strokeWidth={sw}
            style={rippleStyle}
          />
        )
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
  getScale(): number
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

  // Annotation tool cursor preview position (pane-relative screen coords)
  const [annotCursorPos, setAnnotCursorPos] = useState<{ x: number; y: number } | null>(null)

  // Newly placed annotation id — drives the pop/ripple CSS animation
  const [newlyAddedId, setNewlyAddedId] = useState<string | null>(null)
  const newlyAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fix #2: hide img until fitScale/offset are applied to prevent left-flash on paste
  const [imageFitted, setImageFitted] = useState(false)
  // Fix #7: image info overlay (dimensions + size)
  const [imageInfo, setImageInfo] = useState<{ w: number; h: number; sizeKB: number } | null>(null)

  function applyTransform(ns: number, nox: number, noy: number): void {
    scaleRef.current = ns
    offsetRef.current = { x: nox, y: noy }
    setScale(ns)
    setOffset({ x: nox, y: noy })
  }

  // Fit image to pane when a new imageSrc arrives and build offscreen canvas
  useEffect(() => {
    // Fix #2: reset fitted flag so img stays hidden until transform is computed
    setImageFitted(false)
    setImageInfo(null)
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
      // Fix #2: reveal image only after transform is committed
      setImageFitted(true)
      // Fix #7: store image dimensions + estimated file size
      const sizeKB = Math.round(imageSrc.length * 0.75 / 1024)
      setImageInfo({ w: img.naturalWidth, h: img.naturalHeight, sizeKB })
    }
    img.src = imageSrc
  }, [imageSrc]) // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel pan/zoom — non-passive to allow preventDefault
  // macOS: 2本指スクロール → ctrlKey=false → パン, ピンチ → ctrlKey=true → ズーム (v3-C)
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      e.preventDefault()
      if (!e.ctrlKey) {
        // 2-finger scroll = pan: offsetRef をdeltaX/deltaYで更新
        const off = offsetRef.current
        applyTransform(scaleRef.current, off.x - e.deltaX, off.y - e.deltaY)
      } else {
        // ctrl+wheel / pinch = zoom (さらにゆっくり); ボタンズームは ZOOM_STEP=1.25 のまま
        const factor = e.deltaY < 0 ? 1.04 : 1 / 1.04
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
    },
    getScale() {
      return scaleRef.current
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

    // Track position for annotation tool circle preview cursor
    if (annotationTool) setAnnotCursorPos({ x: sx, y: sy })

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
      // Trigger pop + ripple animation for this annotation
      setNewlyAddedId(newAnn.id)
      if (newlyAddedTimerRef.current) clearTimeout(newlyAddedTimerRef.current)
      newlyAddedTimerRef.current = setTimeout(() => setNewlyAddedId(null), 300)
      return
    }

    setIsPanning(false)
  }

  function stopPan(): void {
    setIsPanning(false)
    setEyeHover(null)
    setAnnotCursorPos(null)
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
    else if (annotationTool) cursor = 'none'  // circle preview overlay replaces cursor
    else cursor = isPanning ? 'grabbing' : 'grab'
  }

  // Adaptive color for cursor preview circle (matches actual marker rendering, issue #5)
  let previewStroke = STROKE_ON_DARK
  if (annotationTool && annotCursorPos && offscreenRef.current) {
    const imgPos = screenToImg(annotCursorPos.x, annotCursorPos.y)
    const lum = sampleLuminanceCircle(offscreenRef.current, imgPos.x, imgPos.y, CIRCLE_VR / scaleRef.current)
    previewStroke = lum > 0.45 ? STROKE_ON_LIGHT : STROKE_ON_DARK
  }

  return (
    <div
      ref={paneRef}
      role="region"
      aria-label="Image canvas"
      tabIndex={-1}
      style={{
        flex: 1,
        minWidth: 0,
        background: '#2b2b2e',
        position: 'relative',
        overflow: 'hidden',
        outline: 'none',
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
              pointerEvents: 'none',
              // Fix #2: hide until fitScale/offset are applied — prevents left-flash on paste
              visibility: imageFitted ? 'visible' : 'hidden'
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
                    isNew={ann.id === newlyAddedId}
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

          {/* Annotation tool cursor — circle stamp preview following the mouse */}
          {annotationTool && annotCursorPos && !preview && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: annotCursorPos.x,
                top: annotCursorPos.y,
                width: CIRCLE_VR * 2,
                height: CIRCLE_VR * 2,
                borderRadius: '50%',
                border: `2.5px solid ${previewStroke}`,
                boxShadow: `0 0 0 1.5px rgba(0,0,0,0.45)`,
                opacity: 0.72,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                zIndex: 60
              }}
            />
          )}

          {/* Eyedropper floating preview */}
          {eyedropperTool && eyeHover && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: eyeHover.px + 16,
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

          {/* Fix #7: image info overlay — bottom-left, subtle */}
          {imageInfo && imageFitted && (
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                bottom: 64,  // above floating toolbar (bottom:16 + height:40 + gap:8)
                left: 10,
                fontSize: 10,
                fontFamily: 'monospace',
                color: 'rgba(200,200,210,0.40)',
                pointerEvents: 'none',
                userSelect: 'none',
                lineHeight: 1.4,
                zIndex: 50,
                whiteSpace: 'nowrap'
              }}
            >
              {imageInfo.w} × {imageInfo.h} px
              {' · '}
              {imageInfo.sizeKB >= 1024
                ? `${(imageInfo.sizeKB / 1024).toFixed(1)} MB`
                : `${imageInfo.sizeKB} KB`}
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
  onNavigatePrev?: () => void  // ↑ on first line → focus prev textarea
  onNavigateNext?: () => void  // ↓ on last line → focus next textarea
}

function AnnRow({ ann, textareaRef, onChange, onDelete, onNavigatePrev, onNavigateNext }: AnnRowProps) {
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
          background: '#52525a',  // 無彩色（インスペクタの番号は中立に。キャンバス上のマーカーのみ有彩色）
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: '1',
          color: '#ffffff',  // 白文字 on #52525a ≈ 6.6:1 ✓
          marginTop: 5,
          letterSpacing: '-0.01em'
        }}
      >
        {/* HTML flex centering suffices here — no dy offset needed (SVG/canvas apply their own corrections) */}
        {ann.n}
      </div>

      {/* Text input */}
      <textarea
        ref={textareaRef}
        value={ann.text}
        onChange={e => onChange(ann.id, e.target.value)}
        aria-label={`Annotation ${ann.n}`}
        placeholder={`Note for #${ann.n}`}
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
        onKeyDown={e => {
          // ESC: blur textarea and return focus to canvas so ⌘V etc. resume
          if (e.key === 'Escape') {
            e.currentTarget.blur()
            document.querySelector<HTMLElement>('[aria-label="Image canvas"]')?.focus()
            return
          }
          // ↑ on top line → focus previous annotation textarea
          if (e.key === 'ArrowUp' && onNavigatePrev) {
            const ta = e.currentTarget
            const beforeCursor = ta.value.slice(0, ta.selectionStart ?? 0)
            if (beforeCursor.lastIndexOf('\n') === -1) {
              e.preventDefault()
              onNavigatePrev()
            }
          }
          // ↓ on bottom line → focus next annotation textarea
          if (e.key === 'ArrowDown' && onNavigateNext) {
            const ta = e.currentTarget
            const afterCursor = ta.value.slice(ta.selectionEnd ?? ta.value.length)
            if (afterCursor.indexOf('\n') === -1) {
              e.preventDefault()
              onNavigateNext()
            }
          }
        }}
      />

      {/* 行右側のアクションボタン群 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        {/* #7: 削除ボタン — tabIndex removed (was -1) so keyboard users can Tab to it */}
        <Tooltip label="Delete">
          <button
            aria-label={`Delete annotation ${ann.n}`}
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
            onFocus={e => {
              e.currentTarget.style.outline = '2px solid #7070cc'  // WCAG 2.4.7 focus visible
              e.currentTarget.style.outlineOffset = '1px'
            }}
            onBlur={e => {
              e.currentTarget.style.outline = 'none'
            }}
          >
            <X size={11} strokeWidth={2} />
          </button>
        </Tooltip>

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
    void window.maruAPI?.writeClipboardText(hex)
    setCopiedHex(hex)
    setAnnouncement(`Copied ${hex.toUpperCase()}`)
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
            <Tooltip key={hex} label={`${hex.toUpperCase()} — click to copy`}>
              <button
                aria-label={`Copy ${hex.toUpperCase()}`}
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
            <Tooltip key={hex} label={`${hex.toUpperCase()} (eyedropper) — click to copy`}>
              <button
                aria-label={`Copy eyedropper color ${hex.toUpperCase()}`}
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
  if (globalText.trim()) lines.push(`Overall: ${globalText}`)
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
  ctx.font = `700 ${fontSz}px "Inter Variable", Inter, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = badgeTextFill(fill)
  // textBaseline='middle' centres vertically — no optical offset needed
  ctx.fillText(String(n), bx, by)
}

/**
 * Render the base image + all annotation markers + adjacent badges onto a new canvas
 * reproducing the current display scale. Returns a PNG data URL.
 *
 * Geometry contract (matches on-screen rendering):
 *   - Output canvas: naturalWidth * scale * dpr × naturalHeight * scale * dpr (+ legend strip)
 *   - Image: drawn at full output dims
 *   - Marker positions: ann.x * scale * dpr, ann.y * scale * dpr  (image coords → output px)
 *   - Marker/badge radii: CIRCLE_VR * dpr, BADGE_VR * dpr  (screen-fixed size × dpr — scale-invariant)
 *   - Pan offset (ox/oy) is NOT applied — always export entire image without viewport crop
 *
 * If legendLines is provided, a text legend strip is burned below the image (v3-C copy-all).
 */
function buildAnnotatedCanvas(
  imageSrc: string,
  annotations: Annotation[],
  offscreen: HTMLCanvasElement | null,
  scale: number = 1,
  legendLines?: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new globalThis.Image()
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1
      // Output dimensions: display-scale × dpr for sharpness
      const scaledW = Math.round(img.naturalWidth * scale * dpr)
      const scaledH = Math.round(img.naturalHeight * scale * dpr)

      // Visual constants — screen-px × dpr (scale-invariant, same appearance as on-screen)
      const circleVR = CIRCLE_VR * dpr
      const badgeVR = BADGE_VR * dpr
      const badgeFontVR = BADGE_FONT_VR * dpr

      // Legend layout (burned below scaled image when legendLines provided)
      const hasLegend = legendLines && legendLines.length > 0
      const legendFontSz = Math.round(14 * dpr)
      const legendLineH = Math.ceil(legendFontSz * 1.7)
      const legendPadX = Math.ceil(16 * dpr)
      const legendPadTop = Math.ceil(14 * dpr)
      const legendPadBot = Math.ceil(16 * dpr)
      const legendBadgeR = Math.round(7 * dpr)
      const legendBadgeFontSz = Math.round(8 * dpr)
      const legendTextX = legendPadX + legendBadgeR * 2 + Math.round(8 * dpr)
      const legendMaxW = Math.max(80, scaledW - legendTextX - legendPadX)
      const legendFont = `300 ${legendFontSz}px "Inter Variable", Inter, -apple-system, sans-serif`

      // 文字単位の折り返し（日本語=空白なしに対応）。canvas2dのmaxWidthによる横圧縮(長体)を回避
      const wrapLegend = (meas: CanvasRenderingContext2D, text: string, maxW: number): string[] => {
        const out: string[] = []
        let cur = ''
        for (const ch of text) {
          const test = cur + ch
          if (cur && meas.measureText(test).width > maxW) { out.push(cur); cur = ch }
          else cur = test
        }
        out.push(cur)
        return out.length ? out : ['']
      }

      type LegendEntry = { n: number | null; sublines: string[]; color: string }
      const legendEntries: LegendEntry[] = []
      if (hasLegend && legendLines) {
        const meas = document.createElement('canvas').getContext('2d')!
        meas.font = legendFont
        for (const line of legendLines) {
          const cp = line.codePointAt(0) ?? 0
          if (cp >= 0x2460 && cp <= 0x2473) {
            legendEntries.push({ n: cp - 0x245f, sublines: wrapLegend(meas, line.slice(1).trimStart(), legendMaxW), color: '#d8d8e0' })
          } else {
            legendEntries.push({ n: null, sublines: wrapLegend(meas, line, legendMaxW), color: '#909098' })
          }
        }
      }
      const legendTotalLines = legendEntries.reduce((s, e) => s + e.sublines.length, 0)
      const legendH = hasLegend
        ? legendPadTop + legendTotalLines * legendLineH + legendPadBot
        : 0

      const canvas = document.createElement('canvas')
      canvas.width = scaledW
      canvas.height = scaledH + legendH
      const ctx = canvas.getContext('2d')!
      // Draw image at display scale
      ctx.drawImage(img, 0, 0, scaledW, scaledH)

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      for (const ann of annotations) {
        // Adaptive colors sample from offscreen (natural-resolution) using image coords — unchanged
        const { stroke, halo } = getAdaptiveColors(offscreen, ann)

        ctx.save()

        // Convert image coords → output canvas px
        const outX = ann.x * scale * dpr
        const outY = ann.y * scale * dpr

        if (ann.kind === 'circle') {
          const r = circleVR
          // halo ring
          ctx.beginPath(); ctx.arc(outX, outY, r, 0, Math.PI * 2)
          ctx.strokeStyle = halo; ctx.lineWidth = HALO_STROKE_W * dpr; ctx.stroke()
          // marker ring
          ctx.beginPath(); ctx.arc(outX, outY, r, 0, Math.PI * 2)
          ctx.strokeStyle = stroke; ctx.lineWidth = MARKER_STROKE_W * dpr; ctx.stroke()
          // badge (adjacent: top-right of circle — same geometry as AnnotationShape)
          drawBadgeCtx(ctx, outX + r + badgeVR * 0.6, outY - r - badgeVR * 0.6, badgeVR, ann.n, stroke, badgeFontVR)
        } else {
          // Rect dims in output px
          const rw = ann.w * scale * dpr
          const rh = ann.h * scale * dpr
          const rx = RECT_RX * scale * dpr
          // halo rect
          ctx.beginPath(); roundRectPath(ctx, outX, outY, rw, rh, rx)
          ctx.strokeStyle = halo; ctx.lineWidth = HALO_STROKE_W * dpr; ctx.stroke()
          // marker rect
          ctx.beginPath(); roundRectPath(ctx, outX, outY, rw, rh, rx)
          ctx.strokeStyle = stroke; ctx.lineWidth = MARKER_STROKE_W * dpr; ctx.stroke()
          // badge (adjacent: top-right of rect)
          drawBadgeCtx(ctx, outX + rw + badgeVR * 0.6, outY - badgeVR * 0.6, badgeVR, ann.n, stroke, badgeFontVR)
        }

        ctx.restore()
      }

      // Burn legend strip below scaled image (v3-C) — 折り返し済み・maxWidth不使用で長体回避
      if (hasLegend && legendEntries.length) {
        ctx.fillStyle = '#1e1e20'
        ctx.fillRect(0, scaledH, canvas.width, legendH)

        let lineIdx = 0
        for (const entry of legendEntries) {
          for (let s = 0; s < entry.sublines.length; s++) {
            const cy = scaledH + legendPadTop + lineIdx * legendLineH + legendLineH / 2
            if (s === 0 && entry.n !== null) {
              // Legend badges: achromatic grey (#52525a, white text) — neutral vs. adaptive marker colors
              drawBadgeCtx(ctx, legendPadX + legendBadgeR, cy, legendBadgeR, entry.n, '#52525a', legendBadgeFontSz)
            }
            ctx.font = legendFont
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            ctx.fillStyle = entry.color
            ctx.fillText(entry.sublines[s], legendTextX, cy)
            lineIdx++
          }
        }
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
  const [annotationTool, setAnnotationTool] = useState(true)  // Fix #3: 起動時から注釈ツールON
  const [eyedropperTool, setEyedropperTool] = useState(false)
  const [paletteColors, setPaletteColors] = useState<string[]>([])
  const [pickedColors, setPickedColors] = useState<string[]>([])
  const [globalText, setGlobalText] = useState('')
  const canvasPaneRef = useRef<CanvasPaneHandle>(null)
  // Tracks whether an image is loaded — used in keyboard handler to avoid stale closure
  const hasImageRef = useRef<boolean>(false)

  // Inspector width (splitter drag — G)
  const [inspectorWidth, setInspectorWidth] = useState(280)
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false)
  const splitterDragRef = useRef<{ startX: number; startW: number } | null>(null)

  function onSplitterMouseDown(e: React.MouseEvent): void {
    e.preventDefault()
    splitterDragRef.current = { startX: e.clientX, startW: inspectorWidth }
    setIsDraggingSplitter(true)

    function onMouseMove(me: MouseEvent): void {
      if (!splitterDragRef.current) return
      // Dragging left → wider inspector
      const delta = splitterDragRef.current.startX - me.clientX
      const newW = Math.min(560, Math.max(280, splitterDragRef.current.startW + delta))
      setInspectorWidth(newW)
    }

    function onMouseUp(): void {
      splitterDragRef.current = null
      setIsDraggingSplitter(false)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
  useEffect(() => { hasImageRef.current = !!imageSrc }, [imageSrc])

  // Refs for inspector text inputs (for auto-focus)
  const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([])
  const globalTextareaRef = useRef<HTMLTextAreaElement>(null)  // 'Overall comment' — ArrowDown from last AnnRow
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
  const [toastKey, setToastKey] = useState(0)
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function triggerCopyFeedback(kind: 'text' | 'image' | 'all'): void {
    setCopiedKind(kind)
    setToastKey(k => k + 1)
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current)
    copyFeedbackTimerRef.current = setTimeout(() => setCopiedKind(null), 1500)
  }

  // No-image toast — shown when paste / drop yields no usable image
  const [noImageToast, setNoImageToast] = useState(false)
  const [noImageToastKey, setNoImageToastKey] = useState(0)
  const noImageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showNoImageToast(): void {
    setNoImageToast(true)
    setNoImageToastKey(k => k + 1)
    if (noImageTimerRef.current) clearTimeout(noImageTimerRef.current)
    noImageTimerRef.current = setTimeout(() => setNoImageToast(false), 2000)
  }

  // ─── Copy handlers ──────────────────────────────────────────────────────────

  function handleCopyText(): void {
    const text = buildTextOutput(annotations, globalText)
    void window.maruAPI?.writeClipboardText(text)
    triggerCopyFeedback('text')  // #3
  }

  async function handleCopyImage(): Promise<void> {
    if (!imageSrc) return
    const offscreen = canvasPaneRef.current?.getOffscreen() ?? null
    const scale = canvasPaneRef.current?.getScale() ?? 1
    const dataUrl = await buildAnnotatedCanvas(imageSrc, annotations, offscreen, scale)
    await window.maruAPI?.writeClipboardImage(dataUrl)
    triggerCopyFeedback('image')  // #3
  }

  async function handleCopyAll(): Promise<void> {
    if (!imageSrc) return
    const offscreen = canvasPaneRef.current?.getOffscreen() ?? null
    const scale = canvasPaneRef.current?.getScale() ?? 1
    // v3-C: 注釈付き画像の下にテキスト凡例を焼き込んだ1枚の合成画像を生成
    const legendText = buildTextOutput(annotations, globalText)
    const legendLines = legendText ? legendText.split('\n') : []
    const dataUrl = await buildAnnotatedCanvas(imageSrc, annotations, offscreen, scale, legendLines)
    await window.maruAPI?.writeClipboardImage(dataUrl)  // 単一PNG (旧: writeClipboardBoth)
    triggerCopyFeedback('all')  // #3
  }

  // Ref to latest export handlers — prevents stale closure in keyboard useEffect(fn, [])
  const exportHandlersRef = useRef({ handleCopyText, handleCopyImage, handleCopyAll })
  useEffect(() => { exportHandlersRef.current = { handleCopyText, handleCopyImage, handleCopyAll } })

  /** Load an image data URL into the canvas (shared by paste + drag & drop) */
  function loadImage(src: string | null): void {
    if (src) {
      setImageSrc(src)
      setAnnotations([])
      setPaletteColors([])
      setPickedColors([])
    } else {
      showNoImageToast()
    }
  }

  async function handlePaste(): Promise<void> {
    const src = (await window.maruAPI?.readClipboardImage()) ?? null
    loadImage(src)
  }

  /** Drag & drop: load first image file dropped onto the canvas area */
  async function handleFileDrop(e: React.DragEvent<HTMLDivElement>): Promise<void> {
    e.preventDefault()
    const file = e.dataTransfer.files[0] as (File & { path?: string }) | undefined
    const filePath = file?.path
    if (filePath) {
      const src = (await window.maruAPI?.readImageFromPath(filePath)) ?? null
      loadImage(src)
    } else {
      showNoImageToast()
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

  // ⌘V / ⌘N / V / A / I / Esc / + / − global keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      // textarea / input へのテキスト貼付と競合しないようフォーカス先を確認
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return

      const meta = e.metaKey || e.ctrlKey

      if (meta && e.key === 'v') { void handlePaste(); return }
      // #10: ⌘N で新規ウィンドウ
      if (meta && e.key === 'n') {
        e.preventDefault()
        void window.maruAPI?.createNewWindow()
        return
      }
      // v3-C: Export キーボードショートカット（ref 経由で最新ハンドラを呼ぶ — stale closure 防止）
      if (meta && !e.shiftKey && e.key === 't') { e.preventDefault(); exportHandlersRef.current.handleCopyText(); return }
      if (meta && !e.shiftKey && e.key === 'e') { e.preventDefault(); void exportHandlersRef.current.handleCopyImage(); return }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); void exportHandlersRef.current.handleCopyAll(); return }

      // Single-key tool shortcuts (no modifier)
      if (meta) return
      switch (e.key) {
        case 'v': case 'V':
          // V: 選択 / パン モード
          setAnnotationTool(false); setEyedropperTool(false)
          break
        case 'a': case 'A':
          // A: 注釈ツール (画像があるときのみ)
          if (hasImageRef.current) { setAnnotationTool(true); setEyedropperTool(false) }
          break
        case 'i': case 'I':
          // I: スポイト (画像があるときのみ)
          if (hasImageRef.current) { setEyedropperTool(true); setAnnotationTool(false) }
          break
        case 'Escape':
          // Esc: ツール解除
          setAnnotationTool(false); setEyedropperTool(false)
          break
        case '+': case '=':
          // +/= : ズームイン
          if (hasImageRef.current) canvasPaneRef.current?.zoomIn()
          break
        case '-':
          // −: ズームアウト
          if (hasImageRef.current) canvasPaneRef.current?.zoomOut()
          break
        case 's': case 'S':
          // S: スクリーンキャプチャ
          e.preventDefault()
          void handleCapture()
          break
        default:
          break
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
        color: '#e0e0e4',
        ...(isDraggingSplitter ? { cursor: 'col-resize', userSelect: 'none' } : {})
      }}
    >
      {/* ── Title bar ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 40,
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
            label="Copy text (⌘T)"
            onClick={handleCopyText}
            active={copiedKind === 'text'}
            disabled={!imageSrc}
          />
          <IconButton
            icon={copiedKind === 'image' ? <Check size={15} strokeWidth={2.5} /> : <FileImage size={15} strokeWidth={1.8} />}
            label="Copy annotated image (⌘E)"
            onClick={() => { void handleCopyImage() }}
            active={copiedKind === 'image'}
            disabled={!imageSrc}
          />
          <IconButton
            icon={copiedKind === 'all' ? <Check size={15} strokeWidth={2.5} /> : <Layers size={15} strokeWidth={1.8} />}
            label="Copy image with legend (⌘⇧C)"
            onClick={() => { void handleCopyAll() }}
            active={copiedKind === 'all'}
            disabled={!imageSrc}
          />
        </div>
      </div>

      {/* ── Copy toast (center-top, fades after 1.5s) ── */}
      {copiedKind && (
        <div
          key={toastKey}
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 50,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(40,40,45,0.92)',
            border: '1px solid #3a3a40',
            borderRadius: 8,
            padding: '5px 16px',
            fontSize: 12,
            fontWeight: 500,
            color: '#e0e0e4',
            pointerEvents: 'none',
            zIndex: 1000,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            whiteSpace: 'nowrap',
            ...(prefersReducedMotion ? {} : { animation: 'toast-fade 1.5s ease-out forwards' })
          }}
        >
          Copied!
        </div>
      )}

      {/* ── No-image toast ── */}
      {noImageToast && (
        <div
          key={noImageToastKey}
          role="alert"
          aria-live="assertive"
          style={{
            position: 'fixed',
            top: 50,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(40,30,30,0.95)',
            border: '1px solid #5a3a3a',
            borderRadius: 8,
            padding: '5px 16px',
            fontSize: 12,
            fontWeight: 500,
            color: '#e8c0c0',
            pointerEvents: 'none',
            zIndex: 1000,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            whiteSpace: 'nowrap',
            ...(prefersReducedMotion ? {} : { animation: 'toast-fade 2.0s ease-out forwards' })
          }}
        >
          No image found in clipboard
        </div>
      )}

      {/* ── Main area ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Canvas area wrapper — relative for floating toolbar, accepts file drag & drop */}
        <div
          style={{ display: 'flex', flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}
          onDragOver={e => e.preventDefault()}
          onDrop={handleFileDrop}
        >
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
              void window.maruAPI?.writeClipboardText(hex)
            }}
            onOffscreenReady={handleOffscreenReady}
          />

          {/* ── Floating toolbar (Figma-style, canvas bottom center) ── */}
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '0 8px',
              height: 40,
              background: '#252527',
              border: '1px solid #3a3a40',
              borderRadius: 12,
              boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
              zIndex: 100,
              pointerEvents: 'auto'
            }}
          >
            <IconButton
              icon={<ClipboardPaste size={15} strokeWidth={1.8} />}
              label="Paste from clipboard (⌘V)"
              onClick={handlePaste}
            />

            <ToolbarDivider />

            <IconButton
              icon={<MousePointer size={15} strokeWidth={1.8} />}
              label="Select / Pan (V)"
              onClick={() => { setAnnotationTool(false); setEyedropperTool(false) }}
              active={!annotationTool && !eyedropperTool}
            />
            <IconButton
              icon={<AnnotationToolIcon />}
              label={annotationTool ? 'Annotate ON (A) — click=circle / drag=rect / click again=delete' : 'Annotate (A)'}
              onClick={toggleAnnotationTool}
              active={annotationTool}
              disabled={!imageSrc}
            />
            <IconButton
              icon={<Pipette size={15} strokeWidth={1.8} />}
              label={eyedropperTool ? 'Eyedropper ON (I) — click to pick color' : 'Eyedropper (I)'}
              onClick={toggleEyedropperTool}
              active={eyedropperTool}
              disabled={!imageSrc}
            />

            <ToolbarDivider />

            <IconButton
              icon={<ZoomIn size={15} strokeWidth={1.8} />}
              label="Zoom in (+)"
              onClick={() => canvasPaneRef.current?.zoomIn()}
              disabled={!imageSrc}
            />
            <IconButton
              icon={<ZoomOut size={15} strokeWidth={1.8} />}
              label="Zoom out (−)"
              onClick={() => canvasPaneRef.current?.zoomOut()}
              disabled={!imageSrc}
            />

            <ToolbarDivider />

            {/* スクリーンキャプチャ */}
            <IconButton
              icon={<Camera size={15} strokeWidth={1.8} />}
              label="Capture screen to new window (S)"
              onClick={() => { void handleCapture() }}
            />
          </div>
        </div>

        {/* Splitter — draggable vertical divider between canvas and inspector */}
        <div
          role="separator"
          aria-label="Resize inspector"
          aria-orientation="vertical"
          onMouseDown={onSplitterMouseDown}
          style={{
            width: 5,
            flexShrink: 0,
            cursor: 'col-resize',
            position: 'relative',
            zIndex: 10,
            background: 'transparent'
          }}
        >
          {/* Visible 1px line inside the 5px hit area */}
          <div style={{
            position: 'absolute',
            top: 0, bottom: 0,
            left: 2, width: 1,
            background: '#2e2e32'
          }} />
        </div>

        {/* Inspector pane */}
        <div
          style={{
            width: inspectorWidth,
            flexShrink: 0,
            background: '#232325',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative'
          }}
        >
          {/* 上限到達トースト — absolute so it doesn't consume layout space */}
          {maxReached && (
            <div
              role="alert"
              style={{
                position: 'absolute',
                top: 8,
                left: 14,
                right: 12,
                zIndex: 10,
                fontSize: 10,
                color: '#e07c00',
                fontWeight: 500,
                pointerEvents: 'none'
              }}
            >
              Maximum {MAX_ANNOTATIONS} annotations
            </div>
          )}

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
                <Circle size={22} strokeWidth={1.2} color="#38383e" />
                <span style={{ color: '#909098' }}>Add an annotation to get started</span>
              </div>
            ) : (
              annotations.map((ann, idx) => (
                <AnnRow
                  key={ann.id}
                  ann={ann}
                  textareaRef={el => { textareaRefs.current[idx] = el }}
                  onChange={handleAnnotationTextChange}
                  onDelete={handleDeleteAnnotation}
                  onNavigatePrev={idx > 0 ? () => textareaRefs.current[idx - 1]?.focus() : undefined}
                  onNavigateNext={idx < annotations.length - 1 ? () => textareaRefs.current[idx + 1]?.focus() : () => globalTextareaRef.current?.focus()}
                />
              ))
            )}
          </div>

          {/* Fix #10a: clear-all anchored below scroll area (not floating in scroll).
              Fix #10b: Trash2 icon distinguishes from per-row X (individual delete). */}
          {annotations.length > 0 && (
            <div style={{
              borderTop: '1px solid #282830',
              padding: '6px 12px',
              flexShrink: 0
            }}>
              <Tooltip label="Clear all">
                <button
                  aria-label="Clear all annotations"
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
                  <Trash2 size={13} strokeWidth={2} />
                </button>
              </Tooltip>
            </div>
          )}

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
              Overall comment
            </label>
            <textarea
              id="global-text"
              ref={globalTextareaRef}
              value={globalText}
              onChange={e => setGlobalText(e.target.value)}
              placeholder="Additional context for the image"
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
              onKeyDown={e => {
                // ESC: blur textarea and return focus to canvas so ⌘V etc. resume (Fix #8)
                if (e.key === 'Escape') {
                  e.currentTarget.blur()
                  document.querySelector<HTMLElement>('[aria-label="Image canvas"]')?.focus()
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
