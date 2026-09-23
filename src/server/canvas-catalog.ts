import { createHash } from 'crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const CANVAS_FILE = /\.canvas\.tsx$/;
const MAX_DEPTH = 4;
const DEFAULT_LIMIT = 200;

export interface CanvasEntry {
  id: string;
  fileName: string;
  relativePath: string;
  rootLabel: string;
  displayName: string;
  absolutePath: string;
  mtimeMs: number;
  size: number;
}

export interface CanvasCatalogOptions {
  /** Shipped `canvases/` directory. Defaults to the repo / extension root. */
  bundledDir?: string;
  extraDirs?: string[];
  scanCursorProjects?: boolean;
  cursorProjectsDir?: string;
  limit?: number;
}

interface CanvasRoot {
  dir: string;
  label: string;
}

export function defaultBundledCanvasDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/server, dist/server, or the extension bundle all sit one level under a parent
  // whose parent is the repo / extension install root.
  return resolve(here, '..', '..', 'canvases');
}

export function defaultCursorProjectsDir(): string {
  return join(homedir(), '.cursor', 'projects');
}

export function loadCanvasCatalog(options: CanvasCatalogOptions = {}): CanvasEntry[] {
  const roots: CanvasRoot[] = [];
  const seenRoots = new Set<string>();

  const addRoot = (dir: string | undefined, label: string) => {
    if (!dir || !existsSync(dir)) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (seenRoots.has(real)) return;
    seenRoots.add(real);
    roots.push({ dir: real, label });
  };

  addRoot(options.bundledDir ?? defaultBundledCanvasDir(), 'canvases');
  for (const dir of options.extraDirs ?? []) {
    addRoot(resolve(dir), basename(resolve(dir)) || dir);
  }
  if (options.scanCursorProjects !== false) {
    const projects = options.cursorProjectsDir ?? defaultCursorProjectsDir();
    if (existsSync(projects)) {
      let names: string[] = [];
      try {
        names = readdirSync(projects);
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!name || name.startsWith('.')) continue;
        addRoot(join(projects, name, 'canvases'), name);
      }
    }
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const seenFiles = new Set<string>();
  const found: Omit<CanvasEntry, 'displayName'>[] = [];

  for (const root of roots) {
    if (found.length >= limit) break;
    for (const file of listCanvasFiles(root.dir)) {
      if (found.length >= limit) break;
      let realFile: string;
      try {
        realFile = realpathSync(file);
      } catch {
        continue;
      }
      if (!isInside(root.dir, realFile) || seenFiles.has(realFile)) continue;
      let st;
      try {
        st = statSync(realFile);
      } catch {
        continue;
      }
      if (!st.isFile() || !CANVAS_FILE.test(basename(realFile))) continue;
      seenFiles.add(realFile);
      const rel = relative(root.dir, realFile).split(sep).join('/');
      found.push({
        id: canvasId(realFile),
        fileName: basename(realFile),
        relativePath: rel,
        rootLabel: root.label,
        absolutePath: realFile,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }

  found.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.rootLabel.localeCompare(b.rootLabel));
  return withDisplayNames(found);
}

export function canvasId(realPath: string): string {
  return createHash('sha256').update(realPath).digest('base64url').slice(0, 22);
}

function withDisplayNames(entries: Omit<CanvasEntry, 'displayName'>[]): CanvasEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.fileName, (counts.get(entry.fileName) ?? 0) + 1);
  }
  return entries.map((entry) => ({
    ...entry,
    displayName: (counts.get(entry.fileName) ?? 0) > 1
      ? `${entry.rootLabel} / ${entry.fileName}`
      : entry.fileName,
  }));
}

function listCanvasFiles(dir: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name || name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listCanvasFiles(full, depth + 1));
    } else if (st.isFile() && CANVAS_FILE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}
