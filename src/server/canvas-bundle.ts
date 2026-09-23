import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const MAX_SOURCE_BYTES = 1_000_000;

export interface MantineStylesheets {
  core: string;
  charts: string;
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function prebuiltDir(): string | null {
  const here = moduleDir();
  const candidates = [
    resolve(here, '..', 'client', 'prebuilt'),
    resolve(here, '..', '..', 'dist', 'client', 'prebuilt'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'demo-canvas.js'))) return dir;
  }
  return null;
}

export function readPrebuiltDemo(): string | null {
  const dir = prebuiltDir();
  if (!dir) return null;
  try {
    return readFileSync(join(dir, 'demo-canvas.js'), 'utf8');
  } catch {
    return null;
  }
}

export function resolveMantineStylesheets(): MantineStylesheets | null {
  try {
    return {
      core: require.resolve('@mantine/core/styles.css'),
      charts: require.resolve('@mantine/charts/styles.css'),
    };
  } catch {
    const dir = prebuiltDir();
    if (!dir) return null;
    const core = join(dir, 'mantine-core.css');
    const charts = join(dir, 'mantine-charts.css');
    if (existsSync(core) && existsSync(charts)) return { core, charts };
    return null;
  }
}

function repoNodeModules(): string | null {
  const here = moduleDir();
  const candidates = [
    resolve(here, '..', '..', 'node_modules'),
    resolve(process.cwd(), 'node_modules'),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

function resolveShimEntries(): { shim: string; runtime: string } {
  let resolved: string;
  try {
    resolved = require.resolve('@thisismydesign/cursor-canvas-web');
  } catch {
    throw new Error(
      'Missing @thisismydesign/cursor-canvas-web. Run npm install in the CursorRemote repo to render canvases.',
    );
  }
  const dist = dirname(resolved);
  return {
    shim: join(dist, 'cursor-canvas.js'),
    runtime: join(dist, 'runtime.js'),
  };
}

export function formatBundleError(err: unknown): Error {
  if (err && typeof err === 'object' && 'errors' in err) {
    const errors = (err as { errors?: { text?: string }[] }).errors;
    if (Array.isArray(errors)) {
      const text = errors.map((item) => item.text || '').filter(Boolean).join('\n');
      if (text) return new Error(text);
    }
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

export async function bundleCanvas(absolutePath: string): Promise<string> {
  let esbuild: typeof import('esbuild');
  try {
    esbuild = await import('esbuild');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Canvas bundler is unavailable (${message}).`);
  }

  const { shim, runtime } = resolveShimEntries();
  const nodeModules = repoNodeModules();
  const entry = `
import { createElement } from 'react';
import { mountCanvas } from ${JSON.stringify(runtime)};
import * as CanvasModule from ${JSON.stringify(absolutePath)};

const Comp = CanvasModule.default;
const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root');
}
if (typeof Comp !== 'function') {
  root.textContent = 'This canvas has no default-exported React component.';
} else {
  mountCanvas(root, createElement(Comp), { defaultColorScheme: 'dark', strict: false });
}
`;

  try {
    const result = await esbuild.build({
      stdin: {
        contents: entry,
        resolveDir: dirname(absolutePath),
        sourcefile: 'canvas-host.js',
        loader: 'js',
      },
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      jsx: 'automatic',
      jsxImportSource: 'react',
      write: false,
      outfile: 'canvas.js',
      alias: {
        'cursor/canvas': shim,
      },
      nodePaths: nodeModules ? [nodeModules] : [],
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      mainFields: ['browser', 'module', 'main'],
      conditions: ['browser', 'import', 'module', 'default'],
      legalComments: 'none',
      logLevel: 'silent',
    });
    const file = result.outputFiles?.find((output) => output.path.endsWith('.js'));
    if (!file) throw new Error('esbuild produced no JavaScript');
    return file.text;
  } catch (err) {
    throw formatBundleError(err);
  }
}

export function assertCanvasSourceSize(size: number): void {
  if (size > MAX_SOURCE_BYTES) {
    throw new Error('Canvas file is larger than 1MB');
  }
}

export function renderCanvasDocument(options: {
  title: string;
  scriptUrl?: string;
  error?: string;
}): string {
  const title = escapeHtml(options.title);
  const body = options.error
    ? `<pre id="boot-error">${escapeHtml(options.error)}</pre>`
    : `<div id="root"></div>${
      options.scriptUrl ? `<script src="${escapeHtml(options.scriptUrl)}"></script>` : ''
    }`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${title}</title>
  <style>
    html, body, #root { height: 100%; }
    body { margin: 0; background: #181818; color: #e4e4e4; }
    #boot-error {
      margin: 0; padding: 16px; white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #e34671; font-size: 12px;
    }
  </style>
  <link rel="stylesheet" href="/canvas-assets/mantine-core.css">
  <link rel="stylesheet" href="/canvas-assets/mantine-charts.css">
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
