import { EventEmitter } from 'events';
import type { CDPBridge } from './cdp-bridge.js';
import type { ServerConfig } from './types.js';
import { type CanvasEntry, canvasRootDir, loadCanvasCatalog } from './canvas-catalog.js';
import {
  CANVAS_PROBE_SOURCE,
  matchDetectedCanvas,
  parseCanvasHits,
  preferredDetectedName,
} from './canvas-detect.js';
import { assertCanvasSourceSize, bundleCanvas, readPrebuiltDemo } from './canvas-bundle.js';

export interface CanvasSummary {
  id: string;
  fileName: string;
  relativePath: string;
  rootLabel: string;
  displayName: string;
  mtimeMs: number;
}

export interface CanvasSnapshot {
  canvases: CanvasSummary[];
  activeId: string | null;
  detectedName: string | null;
  /** `prebuilt` when the open preview fell back to the shipped demo bundle. */
  previewSource: 'live' | 'prebuilt' | null;
}

interface CacheEntry {
  key: string;
  code: string;
}

const CACHE_LIMIT = 20;

export class CanvasService extends EventEmitter {
  private entries: CanvasEntry[] = [];
  private activeId: string | null = null;
  private detectedName: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private probeWarned = false;
  private prebuiltWarned = false;
  private previewSource: 'live' | 'prebuilt' | null = null;
  private lastPublished = '';
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly config: ServerConfig,
    private readonly bridge: CDPBridge,
  ) {
    super();
  }

  start(): void {
    this.reloadCatalog();
    const count = this.entries.length;
    console.log(`[canvas] ${count} canvas file${count === 1 ? '' : 's'} available`);
    this.publish();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.config.canvasPollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): CanvasSnapshot {
    return {
      canvases: this.entries.map((entry) => ({
        id: entry.id,
        fileName: entry.fileName,
        relativePath: entry.relativePath,
        rootLabel: entry.rootLabel,
        displayName: entry.displayName,
        mtimeMs: entry.mtimeMs,
      })),
      activeId: this.activeId,
      detectedName: this.detectedName,
      previewSource: this.previewSource,
    };
  }

  getEntry(id: string): CanvasEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  refresh(): CanvasSnapshot {
    this.reloadCatalog();
    this.publish();
    return this.snapshot();
  }

  async bundle(id: string): Promise<string> {
    const entry = this.getEntry(id);
    if (!entry) throw new Error('Canvas not found');
    assertCanvasSourceSize(entry.size);
    const key = `${entry.mtimeMs}:${entry.size}:${entry.absolutePath}`;
    const cached = this.cache.get(id);
    if (cached && cached.key === key) {
      this.notePreview('live');
      return cached.code;
    }

    const flightKey = `${id}:${key}`;
    let pending = this.inflight.get(flightKey);
    if (!pending) {
      pending = this.build(entry, key).finally(() => {
        this.inflight.delete(flightKey);
      });
      this.inflight.set(flightKey, pending);
    }
    return pending;
  }

  private async build(entry: CanvasEntry, key: string): Promise<string> {
    try {
      const code = await bundleCanvas(entry.absolutePath, canvasRootDir(entry));
      this.remember(entry.id, key, code);
      this.notePreview('live');
      return code;
    } catch (err) {
      const prebuilt = this.prebuiltFallback(entry);
      if (prebuilt) {
        if (!this.prebuiltWarned) {
          this.prebuiltWarned = true;
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[canvas] Live bundle failed for ${entry.fileName}; serving the prebuilt demo (${message})`);
        }
        this.notePreview('prebuilt');
        return prebuilt;
      }
      throw err;
    }
  }

  private notePreview(source: 'live' | 'prebuilt'): void {
    if (this.previewSource === source) return;
    this.previewSource = source;
    this.publish();
  }

  private prebuiltFallback(entry: CanvasEntry): string | null {
    if (entry.rootLabel !== 'canvases' || entry.relativePath !== 'demo.canvas.tsx') return null;
    return readPrebuiltDemo();
  }

  private remember(id: string, key: string, code: string): void {
    if (this.cache.size >= CACHE_LIMIT && !this.cache.has(id)) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.delete(id);
    this.cache.set(id, { key, code });
  }

  private reloadCatalog(): void {
    this.entries = loadCanvasCatalog({
      extraDirs: this.config.canvasDirs,
      scanCursorProjects: this.config.canvasScanCursor,
    });
    if (this.activeId && !this.entries.some((entry) => entry.id === this.activeId)) {
      this.activeId = null;
    }
    if (this.detectedName) {
      const matched = matchDetectedCanvas(
        [{ name: this.detectedName, active: true }],
        this.entries,
      );
      this.activeId = matched?.id ?? null;
    }
  }

  private publish(): void {
    const snapshot = this.snapshot();
    const json = JSON.stringify(snapshot);
    if (json === this.lastPublished) return;
    this.lastPublished = json;
    this.emit('update', snapshot);
  }

  private async poll(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      this.reloadCatalog();
      if (this.bridge.isConnected()) {
        const client = this.bridge.getClient();
        if (client) {
          try {
            const raw = await client.evaluate(`(${CANVAS_PROBE_SOURCE})()`, 2500);
            const hits = parseCanvasHits(raw);
            this.detectedName = preferredDetectedName(hits);
            const matched = matchDetectedCanvas(hits, this.entries);
            this.activeId = matched?.id ?? null;
            this.probeWarned = false;
          } catch (err) {
            if (!this.probeWarned) {
              this.probeWarned = true;
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`[canvas] Open-canvas probe failed: ${message}`);
            }
          }
        }
      }
      this.publish();
    } finally {
      this.probing = false;
    }
  }
}
