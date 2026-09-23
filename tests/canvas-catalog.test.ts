import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadCanvasCatalog } from '../src/server/canvas-catalog.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('canvas catalog', () => {
  it('lists canvas files, ignores other files, and rejects symlinks that leave the root', () => {
    const root = tempDir('canvas-root-');
    const outside = tempDir('canvas-out-');
    try {
      writeFileSync(join(root, 'ok.canvas.tsx'), 'export default function Ok(){return null}\n');
      writeFileSync(join(root, 'notes.txt'), 'nope');
      mkdirSync(join(root, 'nested'));
      writeFileSync(join(root, 'nested', 'inner.canvas.tsx'), 'export default function Inner(){return null}\n');
      writeFileSync(join(outside, 'secret.canvas.tsx'), 'export default function Secret(){return null}\n');
      symlinkSync(join(outside, 'secret.canvas.tsx'), join(root, 'secret.canvas.tsx'));

      const listed = loadCanvasCatalog({
        bundledDir: root,
        scanCursorProjects: false,
        extraDirs: [],
      });
      const names = listed.map((entry) => entry.relativePath).sort();
      assert.deepEqual(names, ['nested/inner.canvas.tsx', 'ok.canvas.tsx']);
      assert.equal(listed.every((entry) => !entry.absolutePath.includes('secret')), true);

      const again = loadCanvasCatalog({
        bundledDir: root,
        scanCursorProjects: false,
        extraDirs: [],
      });
      assert.deepEqual(
        again.map((entry) => entry.id),
        listed.map((entry) => entry.id),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('disambiguates duplicate file names with the root label', () => {
    const first = tempDir('canvas-a-');
    const second = tempDir('canvas-b-');
    try {
      writeFileSync(join(first, 'demo.canvas.tsx'), 'export default function A(){return null}\n');
      writeFileSync(join(second, 'demo.canvas.tsx'), 'export default function B(){return null}\n');
      const listed = loadCanvasCatalog({
        bundledDir: first,
        extraDirs: [second],
        scanCursorProjects: false,
      });
      assert.equal(listed.length, 2);
      assert.ok(listed.every((entry) => entry.displayName.includes('/')));
      assert.notEqual(listed[0].id, listed[1].id);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('includes the shipped demo when cursor project scanning is off', () => {
    const listed = loadCanvasCatalog({ scanCursorProjects: false, extraDirs: [] });
    assert.ok(listed.some((entry) => entry.relativePath === 'demo.canvas.tsx'));
  });
});
