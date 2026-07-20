# Online Whiteboard

A fast, single-file whiteboard app — no build step, no dependencies, works offline.

## Features

- **Draw**: pen, rectangle, ellipse, line, arrow, text, sticky notes, eraser
- **Images**: insert via menu, paste (⌘V), or drag & drop — PNG/JPEG/SVG
- **Edit**: select, move, resize, rotate, duplicate (⌘D), copy/cut/paste, arrow-key nudge
- **Organize**: multi-page boards, z-order (`]` / `[`), lock & lock-as-reference, snap to grid (G)
- **Present**: laser pointer (K) and presenter mode with arrow-key page navigation
- **Export**: PNG, SVG, multi-page PDF, and JSON save/load
- **More**: per-page undo/redo, pan/zoom, dark mode, auto-save to IndexedDB

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| V / H / P / R / O / L / A / S / T / K / E | Tools |
| ⌘Z / ⌘⇧Z | Undo / redo |
| ⌘C / ⌘X / ⌘V / ⌘D | Copy / cut / paste / duplicate |
| ⌘L / ⌘⇧L | Lock selection / unlock all |
| `]` / `[` | Bring to front / send to back |
| G | Snap to grid |
| PgUp / PgDn | Switch pages |
| Space-drag | Pan |

## Development

It's one file: `index.html`. Open it in a browser, edit, refresh.
