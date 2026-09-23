# Canvas panel

The web client has a right-hand panel for Cursor canvases (`.canvas.tsx` files). Chat, approvals, and Telegram are unchanged. The panel is closed until you open it or the relay detects a canvas tab.

## How rendering works

A Cursor canvas imports only from `cursor/canvas`. That module exists inside the IDE, not on npm. [cursor-canvas-web](https://github.com/thisismydesign/cursor-canvas-web) is a Mantine-backed shim of the same API.

This relay does not reimplement that SDK. For each selected file it:

1. Resolves `cursor/canvas` to `@thisismydesign/cursor-canvas-web`.
2. Bundles the file in-process with esbuild, together with React, Mantine, and Recharts.
3. Serves an iframe document that calls `mountCanvas` from `@thisismydesign/cursor-canvas-web/runtime`.

The host passes `defaultColorScheme: "dark"` so the preview matches the CursorRemote UI. `useCanvasAction` stays a no-op on the web, which is the shim's own behavior.

`npm run build` also writes a prebuilt copy of `canvases/demo.canvas.tsx` to `dist/client/prebuilt/`. The extension package can show that demo when the esbuild binary is not installed next to the bundled server. Any other canvas still needs a standalone `npm install` so esbuild and the peer dependencies resolve.

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
| `GET /canvas/view/:id` | Iframe document |
| `GET /canvas/bundle/:id` | Bundled script |

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
