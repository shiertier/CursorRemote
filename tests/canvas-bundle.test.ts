import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { JSDOM } from 'jsdom';
import {
  bundleCanvas,
  canvasImportAllowed,
  loadShimPackageAllowlist,
  renderCanvasDocument,
} from '../src/server/canvas-bundle.js';

describe('canvas bundle', () => {
  it('escapes error text in the preview document', () => {
    const html = renderCanvasDocument({
      title: 'A <b>title</b>',
      error: '<script>alert(1)</script>',
    });
    assert.match(html, /A &lt;b&gt;title&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('inlines the preview and neutralizes script and style breakouts', () => {
    const html = renderCanvasDocument({
      title: 'Preview',
      script: 'window.__x = 1;</script><script>window.__pwn = 1',
      styles: ['body{}</style><link rel="stylesheet" href="https://evil.example/leak">'],
    });
    assert.match(html, /default-src 'none'/);
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(html, /\/canvas\/bundle/);
    assert.doesNotMatch(html, /\/canvas-assets\//);
    assert.equal(html.match(/<\/script>/gi)?.length, 2);
    assert.equal(html.match(/<\/style>/gi)?.length, 2);
    assert.match(html, /__cursor_remote_probe/);
    assert.match(html, /<\\\/script><script>window\.__pwn/);
    assert.match(html, /<\\\/style><link/);
  });

  it('allows canvas-root files and shim packages, and rejects escapes', () => {
    const allow = loadShimPackageAllowlist();
    assert.ok(allow.has('react'));
    assert.ok(allow.has('@mantine/core'));
    assert.ok(allow.has('recharts'));
    assert.ok(allow.has('@thisismydesign/cursor-canvas-web'));
    assert.equal(allow.has('totally-not-a-real-package'), false);

    const root = '/tmp/canvas-root';
    const canvas = '/tmp/canvas-root/demo.canvas.tsx';
    const base = {
      canvasRoot: root,
      allowlist: allow,
      nodeModules: null,
    };
    assert.equal(canvasImportAllowed({
      ...base,
      importer: canvas,
      specifier: './sibling',
      resolvedPath: '/tmp/canvas-root/nested/sibling.tsx',
    }), true);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: canvas,
      specifier: '../../.env',
      resolvedPath: '/tmp/.env',
    }), false);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: canvas,
      specifier: 'fs',
      resolvedPath: 'fs',
    }), false);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: canvas,
      specifier: 'node:fs',
      resolvedPath: 'node:fs',
    }), false);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: canvas,
      specifier: 'react',
      resolvedPath: '/repo/node_modules/react/index.js',
    }), false);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: canvas,
      specifier: 'react/jsx-runtime',
      resolvedPath: '/repo/node_modules/react/jsx-runtime.js',
    }), true);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: canvas,
      specifier: 'cursor/canvas',
      resolvedPath: '/repo/node_modules/@thisismydesign/cursor-canvas-web/dist/cursor-canvas.js',
    }), true);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: '/tmp/canvas-root/cursor-remote-canvas-host.js',
      specifier: 'react',
      resolvedPath: '/repo/node_modules/react/index.js',
    }), true);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: '/repo/node_modules/react/index.js',
      specifier: 'left-pad',
      resolvedPath: '/repo/node_modules/left-pad/index.js',
    }), false);
    assert.equal(canvasImportAllowed({
      ...base,
      importer: '/repo/node_modules/react/index.js',
      specifier: 'loose-envify',
      resolvedPath: '/repo/node_modules/loose-envify/index.js',
    }), allow.has('loose-envify'));
  });

  it('refuses to bundle imports that leave the canvas root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'canvas-allow-'));
    const root = join(parent, 'root');
    const outside = join(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const secret = 'SUPER_SECRET_CANARY_991';
    writeFileSync(join(outside, 'secret.ts'), `export const leak = ${JSON.stringify(secret)};\n`);
    writeFileSync(join(root, 'evil.canvas.tsx'), [
      "import { leak } from '../outside/secret';",
      'export default function Evil() { return leak; }',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'builtin.canvas.tsx'), [
      "import fs from 'fs';",
      'export default function Builtin() { return String(fs); }',
      '',
    ].join('\n'));
    symlinkSync(join(outside, 'secret.ts'), join(root, 'linked.ts'));
    writeFileSync(join(root, 'link.canvas.tsx'), [
      "import { leak } from './linked';",
      'export default function Linked() { return leak; }',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'local.ts'), 'export const label = "INSIDE_ROOT_CANARY";\n');
    writeFileSync(join(root, 'local.canvas.tsx'), [
      "import { label } from './local';",
      'export default function Local() { return label; }',
      '',
    ].join('\n'));
    try {
      await assert.rejects(
        () => bundleCanvas(join(root, 'evil.canvas.tsx'), root),
        /Canvas import blocked/,
      );
      await assert.rejects(
        () => bundleCanvas(join(root, 'builtin.canvas.tsx'), root),
        /Canvas import blocked/,
      );
      await assert.rejects(
        () => bundleCanvas(join(root, 'link.canvas.tsx'), root),
        /Canvas import blocked/,
      );
      const code = await bundleCanvas(join(root, 'local.canvas.tsx'), root);
      assert.match(code, /INSIDE_ROOT_CANARY/);
      assert.doesNotMatch(code, new RegExp(secret));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('bundles the demo canvas with the cursor/canvas shim and mounts it', async () => {
    const code = await bundleCanvas(resolve('canvases/demo.canvas.tsx'), resolve('canvases'));
    assert.match(code, /CursorRemote canvas/);
    assert.doesNotMatch(code, /from ["']cursor\/canvas["']/);
    assert.doesNotMatch(code, /require\(["']cursor\/canvas["']\)/);

    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/canvas/view/demo',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    const window = dom.window;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('dark'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    window.ResizeObserver = ResizeObserverStub as unknown as typeof window.ResizeObserver;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      return window.setTimeout(() => cb(Date.now()), 16);
    }) as typeof window.requestAnimationFrame;

    const script = window.document.createElement('script');
    script.textContent = code;
    window.document.body.appendChild(script);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = window.document.getElementById('root')?.textContent ?? '';
    assert.match(text, /CursorRemote canvas/);
    assert.match(text, /Add check/);
    assert.match(text, /Host theme:/);
  });
});
