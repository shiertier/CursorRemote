import { copyFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { bundleCanvas, resolveMantineStylesheets } from '../src/server/canvas-bundle.js';

const demo = resolve('canvases/demo.canvas.tsx');
const outDir = resolve('dist/client/prebuilt');
mkdirSync(outDir, { recursive: true });

const code = await bundleCanvas(demo);
writeFileSync(resolve(outDir, 'demo-canvas.js'), code);

const styles = resolveMantineStylesheets();
if (!styles) {
  throw new Error('Mantine stylesheets were not found. Install @mantine/core and @mantine/charts.');
}
copyFileSync(styles.core, resolve(outDir, 'mantine-core.css'));
copyFileSync(styles.charts, resolve(outDir, 'mantine-charts.css'));
console.log(`[canvas] Prebuilt demo canvas (${code.length} bytes) -> ${dirname(resolve(outDir, 'demo-canvas.js'))}`);
