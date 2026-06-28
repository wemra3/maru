# maru

**Annotate screenshots, then hand them to your AI coding agent. One image, all context.**

![maru screenshot](docs/screenshot.png)

---

## Why

General-purpose image editors and annotation tools are great for marking up screenshots — but they stop short of the last step: getting that annotated image (and the per-marker notes) into your AI agent's context in one shot.

maru is purpose-built for that handoff. Paste a screenshot, stamp numbered markers, write per-marker instructions in the inspector, then copy a single composite image — photo, circles/rectangles, and legend burned in — and paste it directly into Claude, ChatGPT, or any other AI coding tool.

---

## Features

- **Numbered markers** — circle (click) and rectangle (drag) with auto-numbered badges
- **Per-marker text** — inspector panel shows an input field for each marker; re-numbered automatically on delete
- **Composite image copy (⌘⇧C)** — annotated image + text legend burned into a single PNG, ready to paste into any AI tool
- **Text-only copy (⌘T)** — circled-number list ①②③… for pasting as plain text
- **Annotated image copy (⌘E)** — image + markers at current display scale, no legend
- **Adaptive contrast** — marker color switches between hot magenta and deep purple based on background luminance (WCAG-based)
- **Color palette & eyedropper** — extracts up to 16 representative colors from the pasted image; eyedropper lets you sample any pixel; click any swatch to copy its hex
- **Multiple windows** — ⌘N opens a new independent window
- **Screen capture** — press S to capture a region directly into a new window (wraps macOS `screencapture -i`)
- **Pan & zoom** — two-finger scroll to pan, pinch or ctrl+scroll to zoom, toolbar ± buttons

---

## Install

Download the latest `maru-*.dmg` from [Releases](../../releases).

**Note: maru is unsigned.** macOS will block it on first launch. Right-click the app icon → **Open** → Open. You only need to do this once.

---

## Usage

1. Paste a screenshot: press **⌘V**, or click the clipboard icon in the toolbar
2. Switch to Annotate mode: press **A** (or click the numbered-circle icon)
3. Click to stamp a numbered circle, or drag to draw a numbered rectangle
4. Type instructions for each marker in the right-hand inspector panel
5. (Optional) Add overall context in the **Overall comment** field
6. Press **⌘⇧C** to copy the composite image with legend burned in
7. Paste into Claude, ChatGPT, or any AI tool — everything is in one image

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| ⌘V | Paste image from clipboard |
| ⌘N | New window |
| A | Annotate tool (click = circle, drag = rectangle, click existing = delete) |
| V | Select / Pan |
| I | Eyedropper (click to sample color) |
| Esc | Exit current tool |
| + / = | Zoom in |
| − | Zoom out |
| S | Capture screen region to new window |
| ⌘T | Copy text (numbered list) |
| ⌘E | Copy annotated image |
| ⌘⇧C | Copy composite image with legend |

---

## Build from source

```bash
git clone https://github.com/wemra3/maru.git
cd maru
npm install
npm run dev        # development (hot reload)
npm run build      # production build
npm run dist       # build + package as DMG (macOS)
```

Requirements: Node.js 20+, npm 10+.

The DMG is output to `release/`.

---

## Support

maru is free and open source. If it saves you time, you can support its development:

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ff40d0?logo=github)](https://github.com/sponsors/wemra3)

No paywalls, no tracking — entirely local. ☕

---

## License

[MIT](LICENSE) © 2026 wemra
