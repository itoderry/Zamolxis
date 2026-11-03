/**
 * How many turns are running right now (chats, agent runs, plan steps), across the process.
 * `zamolxis restart` and `update` read it from /api/status and wait for 0, so a restart no
 * longer kills a reply in progress.
 */
let running = 0;

export function turnStarted(): void {
  running++;
}

export function turnEnded(): void {
  running = Math.max(0, running - 1);
}

export function runningTurns(): number {
  return running;
}
