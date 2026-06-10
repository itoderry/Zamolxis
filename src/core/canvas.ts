/**
 * Agent-driven Canvas (OpenClaw-style A2UI): the agent pushes HTML/SVG to a live visual
 * surface the user sees in a desktop window. Shared in-memory state; the tool writes it,
 * the web channel serves it (GET /api/canvas), and the desktop polls + renders it in a
 * sandboxed iframe (the agent's HTML runs isolated — no parent/cookie/same-origin access).
 */
interface CanvasState { html: string; title: string; version: number; ts: number }
let state: CanvasState = { html: '', title: 'Canvas', version: 0, ts: 0 };

/** Replace the canvas content. Returns the new version number. */
export function setCanvas(html: string, title?: string): number {
  state = {
    html: String(html || '').slice(0, 300_000),
    title: String(title || 'Canvas').slice(0, 80),
    version: state.version + 1,
    ts: Date.now(),
  };
  return state.version;
}

export function getCanvas(): CanvasState {
  return state;
}
