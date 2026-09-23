# Canvas panel

The web client has a right-hand panel for Cursor canvases (`.canvas.tsx` files). Chat, approvals, and Telegram are unchanged. The panel is closed until you open it. On a wide layout it also opens when the relay detects a canvas tab. Viewports at 767px and below do not auto-open; the Canvas button and the dropdown still work.

## How rendering works

A Cursor canvas imports only from `cursor/canvas`. That module exists inside the IDE, not on npm. [cursor-canvas-web](https://github.com/thisismydesign/cursor-canvas-web) is a Mantine-backed shim of the same API.

This relay does not reimplement that SDK. For each selected file it:

1. Resolves `cursor/canvas` to `@thisismydesign/cursor-canvas-web`.
2. Bundles the file in-process with esbuild, together with React, Mantine, and Recharts.
3. Serves a self-contained iframe document that calls `mountCanvas` from `@thisismydesign/cursor-canvas-web/runtime`. The script and Mantine styles are inlined into that document.

The host passes `defaultColorScheme: "dark"` so the preview matches the CursorRemote UI. `useCanvasAction` stays a no-op on the web, which is the shim's own behavior.

`npm run build` also writes a prebuilt copy of `canvases/demo.canvas.tsx` to `dist/client/prebuilt/`. The extension package can show that demo when the esbuild binary is not installed next to the bundled server. The panel then shows the status `Prebuilt demo — live bundle failed`. Any other canvas still needs a standalone `npm install` so esbuild and the peer dependencies resolve.

## Isolation

The preview iframe is `sandbox="allow-scripts"` with no `allow-same-origin` and no `allow-top-navigation`. The document therefore has an opaque origin. It cannot read the parent DOM, the session cookie, or `window.parent` properties, and it cannot navigate the top window. The parent page does not accept `postMessage` from the frame.

`/canvas/view/:id` is still a same-site navigation, so a `WEBAPP_PASSWORD` session cookie is sent on that request and missing sessions redirect to `/login`. The document inlines its script and CSS, and its `Content-Security-Policy` is `default-src 'none'` with inline scripts and styles only (`connect-src 'none'`). The opaque frame makes no further requests to the relay. `GET /canvas/bundle/:id` and `/canvas-assets/*` stay behind the same session check for direct fetches; the iframe does not use them.

Chrome blocks `localStorage` in this sandbox. The document installs an in-memory `localStorage` and `sessionStorage` before the bundle so `useCanvasState` and Mantine can mount. That storage lasts for the life of the preview document and is not the parent page's storage.

A blob URL created by the parent page would stay on the parent's origin, so the preview is not loaded that way.

## Import allowlist

esbuild resolves every import and keeps it only when the resolved file is one of:

- the canvas entry, or another file whose real path stays inside that canvas's catalog root (a symlink that points outside the root is rejected)
- `@thisismydesign/cursor-canvas-web` (the `cursor/canvas` shim)
- an allowlisted npm package required by the host or the shim: React, React DOM, Mantine, Recharts, and the transitive dependencies declared by those packages

A canvas file may import other files in its root, the shim, and `react/jsx-runtime` (esbuild's automatic JSX transform). It may not import Node builtins, absolute paths, or packages such as `react` itself. The generated host module is the one that imports React and `mountCanvas`. Attempts to read `../../.env` or a home-directory file fail the bundle.

## Open the panel

1. Start the relay (`npm run dev` or `npm start` after `npm run build`).
2. Open the web client.
3. Press **Canvas** in the header, or choose a file in the panel's dropdown.

Drag the divider to resize. On a narrow viewport the panel covers the chat until you close it. Closing the panel while Cursor still has that canvas focused will not immediately reopen it; it opens again when a different canvas is detected, or when you press **Canvas**.

## Where files come from

| Source | When |
| --- | --- |
| `canvases/` in the repo (includes `demo.canvas.tsx`) | Always, when the directory exists |
| `CANVAS_DIRS` | Comma-separated absolute or relative folders |
| `~/.cursor/projects/*/canvases` | Unless `CANVAS_SCAN_CURSOR=false` |

Only files whose names end in `.canvas.tsx` are listed. Symlinks that resolve outside the scanned root are ignored. The browser receives ids and display names, and can only bundle files from that catalog.

## Detecting the canvas open in Cursor

While CDP is connected, the relay periodically evaluates a small DOM probe in the active workbench: the document title and editor tab labels. A `*.canvas.tsx` name that matches exactly one catalog entry selects that preview and opens the panel.

Tab markup differs across Cursor versions, so this probe is a hint. If nothing matches, or several files share the name, use the dropdown. The probe does not replace chat extraction and does not open extra CDP connections.

## HTTP and socket

| Endpoint / event | Purpose |
| --- | --- |
| `GET /api/canvases` | Catalog plus the detected id, if any |
| `POST /api/canvases/refresh` | Rescan disk |
| `socket` `canvas:update` | Same payload, pushed when the catalog or detection changes |
| `socket` `canvas:refresh` | Ask the server to rescan |
| `GET /canvas/view/:id` | Opaque-origin iframe document (inlined script and CSS) |
| `GET /canvas/bundle/:id` | Bundled script, same session check; the iframe does not request it |

When `WEBAPP_PASSWORD` is set, these routes use the same session cookie or bearer token as the rest of the client.

## Environment

```bash
CANVAS_DIRS=/path/to/one,/path/to/two
CANVAS_SCAN_CURSOR=true
CANVAS_POLL_MS=2000
```

`CANVAS_POLL_MS` below 500 is treated as 2000.

## Adding a canvas

Put a `.canvas.tsx` file in `canvases/` or in a directory listed in `CANVAS_DIRS`. Import only from `cursor/canvas`, and default-export the component. Refresh the list in the panel (or wait for the next poll) and select the file.

The shipped demo exercises layout, stats, a line chart, and `useCanvasState`:

```bash
npm run dev
# http://127.0.0.1:3000 → Canvas → canvases/demo.canvas.tsx
```
