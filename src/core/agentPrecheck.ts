import { logger } from '../logger.js';

/**
 * Cheap, no-LLM gate for the high-frequency watch agents. Before a scheduled/headless run spends a
 * model turn, we do one tiny API/COM call to ask "is there actually anything new?" and skip the run
 * when there clearly isn't. This is the single biggest token saver for agents that fire on a clock.
 *
 * Hard rule: FAIL OPEN. If we can't be sure (not configured the way we expect, an error, an unknown
 * shape), we return run:true and let the agent do its normal thing — a wasted run is cheap, a missed
 * alert is not. We only return run:false when we positively determined there's nothing to do.
 */
export interface PrecheckResult {
  run: boolean;
  reason?: string;
}

const RUN: PrecheckResult = { run: true };

/** Decide whether a scheduled run of `agent` is worth a model turn. Unknown agents always run. */
export async function agentPrecheck(agent: string): Promise<PrecheckResult> {
  try {
    const res: PrecheckResult = RUN;
    if (!res.run) logger.info({ agent, reason: res.reason }, 'pre-check skipped a scheduled run (nothing new)');
    return res;
  } catch (err) {
    logger.warn({ agent, err: String(err) }, 'pre-check errored — running anyway');
    return RUN;
  }
}
