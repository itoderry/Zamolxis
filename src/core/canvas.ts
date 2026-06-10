/**
 * Agent-driven Canvas (OpenClaw-style A2UI): the agent pushes HTML/SVG to a live visual
 * surface the user sees in a desktop window. Shared in-memory state; the tool writes it,
 * the web channel serves it (GET /api/canvas), and the desktop polls + renders it in a
 * sandboxed iframe (the agent's HTML runs isolated — no parent/cookie/same-origin access).
 */
interface CanvasState { kind: 'html' | 'table'; html: string; columns: string[]; rows: string[][]; title: string; version: number; ts: number }
let state: CanvasState = { kind: 'html', html: '', columns: [], rows: [], title: 'Canvas', version: 0, ts: 0 };

/** Replace the canvas with an HTML document. Returns the new version number. */
export function setCanvas(html: string, title?: string): number {
  state = { kind: 'html', html: String(html || '').slice(0, 300_000), columns: [], rows: [], title: String(title || 'Canvas').slice(0, 80), version: state.version + 1, ts: Date.now() };
  return state.version;
}

/** Replace the canvas with STRUCTURED tabular data — compact to transfer, rendered as a fast
 *  sortable grid by the client (far cheaper than the model emitting a big HTML table). */
export function setCanvasTable(columns: string[], rows: string[][], title?: string): number {
  const cols = (columns || []).map((c) => String(c)).slice(0, 60);
  const rws = (rows || []).slice(0, 5000).map((r) => (r || []).map((v) => (v == null ? '' : String(v))).slice(0, cols.length || 60));
  state = { kind: 'table', html: '', columns: cols, rows: rws, title: String(title || 'Table').slice(0, 80), version: state.version + 1, ts: Date.now() };
  return state.version;
}

export function getCanvas(): CanvasState {
  return state;
}
