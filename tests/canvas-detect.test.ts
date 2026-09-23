import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  CANVAS_PROBE_SOURCE,
  matchDetectedCanvas,
  parseCanvasHits,
  preferredDetectedName,
} from '../src/server/canvas-detect.js';

describe('canvas detection', () => {
  it('reads canvas file names from the workbench title and the active tab', () => {
    const dom = new JSDOM(`<!DOCTYPE html>
      <html>
        <head><title>notes.canvas.tsx - demo - Cursor</title></head>
        <body>
          <div class="tab" role="tab">
            <a class="label-name">old.canvas.tsx</a>
          </div>
          <div class="tab active" role="tab" aria-selected="true">
            <a class="label-name" title="demo.canvas.tsx">demo.canvas.tsx</a>
          </div>
        </body>
      </html>`, { url: 'http://localhost/', runScripts: 'dangerously' });

    const script = dom.window.document.createElement('script');
    script.textContent = `window.__canvasHits = (${CANVAS_PROBE_SOURCE})();`;
    dom.window.document.body.appendChild(script);
    const raw = (dom.window as unknown as { __canvasHits: unknown }).__canvasHits;
    const hits = parseCanvasHits(raw);
    assert.equal(preferredDetectedName(hits), 'demo.canvas.tsx');
    const names = hits.map((hit) => hit.name).sort();
    assert.deepEqual(names, ['demo.canvas.tsx', 'notes.canvas.tsx', 'old.canvas.tsx']);
    assert.equal(hits.find((hit) => hit.name === 'demo.canvas.tsx')?.active, true);
    assert.equal(hits.find((hit) => hit.name === 'old.canvas.tsx')?.active, false);
  });

  it('matches a single catalog entry and skips ambiguous names', () => {
    const canvases = [
      { id: 'one', fileName: 'demo.canvas.tsx' },
      { id: 'two', fileName: 'other.canvas.tsx' },
      { id: 'three', fileName: 'other.canvas.tsx' },
    ];
    assert.equal(
      matchDetectedCanvas(
        [{ name: 'demo.canvas.tsx', active: true }, { name: 'missing.canvas.tsx', active: false }],
        canvases,
      )?.id,
      'one',
    );
    assert.equal(
      matchDetectedCanvas([{ name: 'other.canvas.tsx', active: true }], canvases),
      null,
    );
    assert.equal(parseCanvasHits([{ name: '../etc/passwd', active: true }]).length, 0);
  });
});
