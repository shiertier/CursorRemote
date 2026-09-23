import { createRequire } from 'module';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import type { Plugin } from 'esbuild';

const require = createRequire(import.meta.url);
const MAX_SOURCE_BYTES = 1_000_000;
const HOST_FILE = 'cursor-remote-canvas-host.js';
const SHIM_PACKAGE = '@thisismydesign/cursor-canvas-web';

/** Packages the generated host and the shim are allowed to import, plus their transitive deps. */
const PACKAGE_SEEDS = [
  'react',
  'react-dom',
  'scheduler',
  '@mantine/core',
  '@mantine/hooks',
  '@mantine/charts',
  'recharts',
  SHIM_PACKAGE,
];

const JSX_RUNTIME_SPECIFIERS = new Set(['react/jsx-runtime', 'react/jsx-dev-runtime']);

const BLOCKED_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'vm',
  'wasi', 'worker_threads', 'zlib',
]);

export const CANVAS_DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

let packageAllowlistCache: Set<string> | null = null;

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

export interface CanvasImportCheck {
  importer: string;
  specifier: string;
  resolvedPath: string;
  canvasRoot: string;
  allowlist: ReadonlySet<string>;
  nodeModules?: string | null;
}

export function loadShimPackageAllowlist(nodeModules?: string | null): Set<string> {
  const nm = nodeModules === undefined ? repoNodeModules() : nodeModules;
  if (nodeModules === undefined && packageAllowlistCache) return packageAllowlistCache;
  const allow = new Set<string>(PACKAGE_SEEDS);
  if (!nm) {
    if (nodeModules === undefined) packageAllowlistCache = allow;
    return allow;
  }
  const queue = [...PACKAGE_SEEDS];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.pop();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    allow.add(name);
    for (const dep of readPackageDependencyNames(join(nm, name, 'package.json'))) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  if (nodeModules === undefined) packageAllowlistCache = allow;
  return allow;
}

export function canvasImportAllowed(check: CanvasImportCheck): boolean {
  const specifier = check.specifier.trim();
  if (isBlockedBuiltin(specifier) || specifier.startsWith('node:') || specifier.startsWith('file:')) return false;
  if (check.resolvedPath.startsWith('node:') || check.resolvedPath.startsWith('file:')) return false;

  const nodeModules = check.nodeModules ?? null;
  const kind = importerClass(check.importer, check.canvasRoot, check.allowlist, nodeModules);
  const pkg = packageNameForAllowlist(check.resolvedPath, nodeModules, check.allowlist);

  if (kind === 'host') {
    if (pkg && check.allowlist.has(pkg)) return true;
    return isUnderCanvasRoot(check.resolvedPath, check.canvasRoot);
  }
  if (kind === 'canvas') {
    if (isUnderCanvasRoot(check.resolvedPath, check.canvasRoot)) return true;
    if (pkg === SHIM_PACKAGE) return true;
    return JSX_RUNTIME_SPECIFIERS.has(specifier);
  }
  if (kind === 'package') {
    return Boolean(pkg && check.allowlist.has(pkg));
  }
  return false;
}

export async function bundleCanvas(absolutePath: string, canvasRoot: string): Promise<string> {
  let esbuild: typeof import('esbuild');
  try {
    esbuild = await import('esbuild');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Canvas bundler is unavailable (${message}).`);
  }

  const root = realpathSync(canvasRoot);
  const entryPath = realpathSync(absolutePath);
  if (!isInside(root, entryPath)) {
    throw new Error('Canvas entry is outside the canvas root');
  }

  const { shim, runtime } = resolveShimEntries();
  const nodeModules = repoNodeModules();
  const allowlist = loadShimPackageAllowlist(nodeModules);
  const entry = `
import { createElement } from 'react';
import { mountCanvas } from ${JSON.stringify(runtime)};
import * as CanvasModule from ${JSON.stringify(entryPath)};

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
        resolveDir: dirname(entryPath),
        sourcefile: HOST_FILE,
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
      plugins: [canvasAllowlistPlugin({ canvasRoot: root, allowlist, nodeModules })],
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

export function readCanvasDocumentStyles(): string[] {
  const styles = resolveMantineStylesheets();
  if (!styles) return [];
  try {
    return [readFileSync(styles.core, 'utf8'), readFileSync(styles.charts, 'utf8')];
  } catch {
    return [];
  }
}

export function neutralizeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}

export function neutralizeInlineStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

export function renderCanvasDocument(options: {
  title: string;
  script?: string;
  styles?: string[];
  error?: string;
}): string {
  const title = escapeHtml(options.title);
  const styleTags = (options.styles ?? [])
    .map((css) => `<style>${neutralizeInlineStyle(css)}</style>`)
    .join('\n');
  const body = options.error
    ? `<pre id="boot-error">${escapeHtml(options.error)}</pre>`
    : `<div id="root"></div>${
      options.script
        ? `<script>${STORAGE_SHIM}</script><script>${neutralizeInlineScript(options.script)}</script>`
        : ''
    }`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta http-equiv="Content-Security-Policy" content="${CANVAS_DOCUMENT_CSP}">
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
  ${styleTags}
</head>
<body>
${body}
</body>
</html>`;
}

const STORAGE_SHIM = `(function () {
  function memoryStorage() {
    var data = Object.create(null);
    return {
      getItem: function (key) {
        var name = String(key);
        return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : null;
      },
      setItem: function (key, value) { data[String(key)] = String(value); },
      removeItem: function (key) { delete data[String(key)]; },
      clear: function () {
        Object.keys(data).forEach(function (key) { delete data[key]; });
      },
      key: function (index) { return Object.keys(data)[index] || null; },
      get length() { return Object.keys(data).length; },
    };
  }
  function install(name) {
    var storage = memoryStorage();
    try {
      window[name].getItem('__cursor_remote_probe');
    } catch (err) {
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          get: function () { return storage; },
        });
      } catch (defineErr) {}
    }
  }
  install('localStorage');
  install('sessionStorage');
})();`;

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

function canvasAllowlistPlugin(options: {
  canvasRoot: string;
  allowlist: ReadonlySet<string>;
  nodeModules: string | null;
}): Plugin {
  return {
    name: 'canvas-import-allowlist',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point') return null;
        const marker = args.pluginData as { canvasAllowlist?: boolean } | undefined;
        if (marker?.canvasAllowlist) return null;
        if (isBlockedBuiltin(args.path)) {
          return { errors: [{ text: `Canvas import blocked: ${args.path}` }] };
        }

        const resolved = await build.resolve(args.path, {
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { canvasAllowlist: true },
        });
        if (resolved.errors.length > 0) {
          return { errors: resolved.errors, warnings: resolved.warnings };
        }

        const allowed = canvasImportAllowed({
          importer: args.importer,
          specifier: args.path,
          resolvedPath: resolved.path,
          canvasRoot: options.canvasRoot,
          allowlist: options.allowlist,
          nodeModules: options.nodeModules,
        });
        if (!allowed || resolved.external) {
          return { errors: [{ text: `Canvas import blocked: ${args.path}` }] };
        }

        return {
          path: resolved.path,
          namespace: resolved.namespace,
          sideEffects: resolved.sideEffects,
          suffix: resolved.suffix,
        };
      });
    },
  };
}

function importerClass(
  importer: string,
  canvasRoot: string,
  allowlist: ReadonlySet<string>,
  nodeModules: string | null,
): 'host' | 'canvas' | 'package' | 'unknown' {
  if (!importer || importer === '<stdin>' || basename(importer) === HOST_FILE) return 'host';
  if (packageNameFromResolvedPath(importer)) {
    const pkg = packageNameForAllowlist(importer, nodeModules, allowlist);
    return pkg && allowlist.has(pkg) ? 'package' : 'unknown';
  }
  return isUnderCanvasRoot(importer, canvasRoot) ? 'canvas' : 'unknown';
}

function isBlockedBuiltin(specifier: string): boolean {
  const bare = specifier.trim();
  if (bare.startsWith('node:')) return true;
  return BLOCKED_BUILTINS.has(bare);
}

function packageNameFromResolvedPath(resolvedPath: string): string | null {
  const parts = resolvedPath.split(/[/\\]/);
  const idx = parts.lastIndexOf('node_modules');
  if (idx < 0) return null;
  const next = parts[idx + 1];
  if (!next) return null;
  if (next.startsWith('@')) {
    const name = parts[idx + 2];
    if (!name) return null;
    return `${next}/${name}`;
  }
  return next;
}

function packageNameForAllowlist(
  resolvedPath: string,
  nodeModules: string | null,
  allowlist: ReadonlySet<string>,
): string | null {
  const direct = packageNameFromResolvedPath(resolvedPath);
  if (direct) return direct;
  if (!nodeModules) return null;
  let realFile: string;
  try {
    realFile = realpathSync(resolvedPath);
  } catch {
    return null;
  }
  for (const name of allowlist) {
    let realPkg: string;
    try {
      realPkg = realpathSync(join(nodeModules, name));
    } catch {
      continue;
    }
    if (isInside(realPkg, realFile)) return name;
  }
  return null;
}

function isUnderCanvasRoot(resolvedPath: string, canvasRoot: string): boolean {
  if (!resolvedPath || packageNameFromResolvedPath(resolvedPath)) return false;
  let root: string;
  try {
    root = realpathSync(canvasRoot);
  } catch {
    root = resolve(canvasRoot);
  }
  let file: string;
  try {
    file = realpathSync(resolvedPath);
  } catch {
    file = resolve(resolvedPath);
  }
  return isInside(root, file);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function readPackageDependencyNames(packageJsonPath: string): string[] {
  try {
    const json = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(json.dependencies ?? {}),
      ...Object.keys(json.peerDependencies ?? {}),
      ...Object.keys(json.optionalDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}
