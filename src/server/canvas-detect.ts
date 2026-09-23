/**
 * Best-effort detection of a canvas tab inside Cursor's workbench DOM.
 * Editor tab markup changes between Cursor versions, so a miss falls back to
 * the explicit file list in the web panel.
 */

export interface DetectedCanvasHit {
  name: string;
  active: boolean;
}

const FILE_NAME = /^[A-Za-z0-9_.$()\- ]+\.canvas\.tsx$/;

export const CANVAS_PROBE_SOURCE = `function probeOpenCanvases() {
  var re = /[A-Za-z0-9_.$()\\- ]+?\\.canvas\\.tsx/g;
  var found = [];
  function add(text, active) {
    if (!text) return;
    var matches = String(text).match(re);
    if (!matches) return;
    for (var i = 0; i < matches.length; i++) {
      var name = matches[i].trim();
      if (!name) continue;
      var existing = null;
      for (var j = 0; j < found.length; j++) {
        if (found[j].name === name) { existing = found[j]; break; }
      }
      if (existing) {
        if (active) existing.active = true;
      } else {
        found.push({ name: name, active: !!active });
      }
    }
  }
  var nodes = document.querySelectorAll('[role="tab"], .tab, .label-name');
  for (var n = 0; n < nodes.length; n++) {
    var el = nodes[n];
    var active = false;
    if (el.getAttribute && el.getAttribute('aria-selected') === 'true') active = true;
    if (el.classList && el.classList.contains('active')) active = true;
    var parent = el.closest ? el.closest('[role="tab"], .tab') : null;
    if (parent) {
      if (parent.getAttribute('aria-selected') === 'true') active = true;
      if (parent.classList && parent.classList.contains('active')) active = true;
    }
    add(el.getAttribute && el.getAttribute('aria-label'), active);
    add(el.getAttribute && el.getAttribute('title'), active);
    add(el.textContent, active);
  }
  var hasActive = false;
  for (var k = 0; k < found.length; k++) if (found[k].active) hasActive = true;
  try { add(document.title, !hasActive); } catch (e) { /* ignore */ }
  return found.slice(0, 30);
}`;

export function normalizeCanvasFileName(name: string): string | null {
  const base = name.split(/[/\\]/).pop()?.trim() ?? '';
  if (!FILE_NAME.test(base)) return null;
  return base;
}

export function parseCanvasHits(raw: unknown): DetectedCanvasHit[] {
  if (!Array.isArray(raw)) return [];
  const hits: DetectedCanvasHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { name?: unknown; active?: unknown };
    if (typeof record.name !== 'string') continue;
    const name = normalizeCanvasFileName(record.name);
    if (!name) continue;
    const active = record.active === true;
    const existing = hits.find((hit) => hit.name === name);
    if (existing) {
      if (active) existing.active = true;
    } else {
      hits.push({ name, active });
    }
  }
  return hits;
}

export function preferredDetectedName(hits: DetectedCanvasHit[]): string | null {
  if (hits.length === 0) return null;
  return (hits.find((hit) => hit.active) ?? hits[0]).name;
}

export function matchDetectedCanvas<T extends { id: string; fileName: string }>(
  hits: DetectedCanvasHit[],
  canvases: T[],
): T | null {
  const ordered = [...hits].sort((a, b) => Number(b.active) - Number(a.active));
  for (const hit of ordered) {
    const matches = canvases.filter((canvas) => canvas.fileName === hit.name);
    if (matches.length === 1) return matches[0];
  }
  return null;
}
