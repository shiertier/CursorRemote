import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';
import { bundleCanvas, renderCanvasDocument } from '../src/server/canvas-bundle.js';

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

  it('bundles the demo canvas with the cursor/canvas shim and mounts it', async () => {
    const code = await bundleCanvas(resolve('canvases/demo.canvas.tsx'));
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
