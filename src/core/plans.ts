/**
 * Workflow approval canvas - shared plan store.
 *
 * The flagship human-in-the-loop feature: instead of firing off a multi-step task
 * blind, the agent PROPOSES a plan (via the `propose_plan` tool). It lands here as
 * a 'proposed' plan and is surfaced in the Workflow Canvas desktop app, where the
 * user reviews the steps and Approves or Rejects. On approval the web channel runs
 * the steps one at a time through the engine, writing each step's status and result
 * back here so the UI shows progress live. Nothing executes without an explicit yes.
 *
 * In-memory + capped, exactly like the Canvas store - a plan is a short-lived unit of
 * work, not durable state.
 */
export type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';
export type PlanStatus = 'proposed' | 'approved' | 'running' | 'done' | 'rejected';

export interface PlanStep {
  n: number;
  title: string;
  detail: string; // the instruction executed for this step
  status: StepStatus;
  result?: string;
}

export interface Plan {
  id: string;
  title: string;
  goal: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdTs: number;
  updatedTs: number;
  conversationKey?: string;
  channel?: string;
  chatId?: string;
  note?: string; // free-text status line (e.g. an error, or "awaiting approval")
}

const MAX_PLANS = 40;
const plans: Plan[] = [];
let seq = 0;

/** Register a newly proposed plan. Returns its id. */
export function proposePlan(input: {
  title: string;
  goal?: string;
  steps: Array<{ title: string; detail?: string }>;
  conversationKey?: string;
  channel?: string;
  chatId?: string;
}): Plan {
  seq += 1;
  const id = `plan_${Date.now().toString(36)}_${seq}`;
  const steps: PlanStep[] = (input.steps || []).slice(0, 30).map((s, i) => ({
    n: i + 1,
    title: String(s.title || `Step ${i + 1}`).slice(0, 200),
    detail: String(s.detail || s.title || '').slice(0, 4000),
    status: 'pending' as StepStatus,
  }));
  const now = Date.now();
  const plan: Plan = {
    id,
    title: String(input.title || 'Untitled plan').slice(0, 200),
    goal: String(input.goal || '').slice(0, 2000),
    steps,
    status: 'proposed',
    createdTs: now,
    updatedTs: now,
    conversationKey: input.conversationKey,
    channel: input.channel,
    chatId: input.chatId,
    note: 'Awaiting your approval.',
  };
  plans.unshift(plan);
  while (plans.length > MAX_PLANS) plans.pop();
  return plan;
}

export function listPlans(): Plan[] {
  return plans.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s })) }));
}

export function getPlan(id: string): Plan | undefined {
  const p = plans.find((x) => x.id === id);
  return p ? { ...p, steps: p.steps.map((s) => ({ ...s })) } : undefined;
}

/** Internal mutable accessor (the runner mutates in place; readers get copies). */
function raw(id: string): Plan | undefined {
  return plans.find((x) => x.id === id);
}

export function setPlanStatus(id: string, status: PlanStatus, note?: string): void {
  const p = raw(id);
  if (!p) return;
  p.status = status;
  if (note !== undefined) p.note = note;
  p.updatedTs = Date.now();
}

export function updateStep(id: string, n: number, patch: Partial<PlanStep>): void {
  const p = raw(id);
  if (!p) return;
  const s = p.steps.find((x) => x.n === n);
  if (!s) return;
  if (patch.status !== undefined) s.status = patch.status;
  if (patch.result !== undefined) s.result = String(patch.result).slice(0, 8000);
  if (patch.title !== undefined) s.title = patch.title;
  if (patch.detail !== undefined) s.detail = patch.detail;
  p.updatedTs = Date.now();
}

export function deletePlan(id: string): boolean {
  const i = plans.findIndex((x) => x.id === id);
  if (i < 0) return false;
  plans.splice(i, 1);
  return true;
}
