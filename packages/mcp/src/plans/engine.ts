import type { LoadedEvent } from "../config/load.js";
import type { GhApi } from "../github/api.js";
import { errorMessage } from "../github/api.js";
import type { Change, StateDb } from "../state/db.js";
import type { TableReader } from "../roster/sources.js";
import { countBy, newConfirmCode, newId, sha256, sleep, UserError } from "../lib/util.js";

export type { Change } from "../state/db.js";

export interface Ctx {
  ev: LoadedEvent;
  gh: GhApi;
  db: StateDb;
  actor: string;
  /** Override for tests; defaults to the configured sheet/CSV reader. */
  read?: TableReader;
  now?: () => Date;
}

export interface PlanResult {
  changes: Change[];
  warnings: string[];
  /** Extra read-only output (blocked repos, links, ...). Not part of the plan hash. */
  info?: Record<string, unknown>;
}

export interface PlanKind<I> {
  kind: string;
  codePrefix: string;
  compute(ctx: Ctx, input: I): Promise<PlanResult>;
  /** Pause between writes for this kind, capped by write_delay_ms (freeze goes faster so all teams lock together). */
  writeDelayMs?: number;
  /** Scratch is shared across one apply run (e.g. team ids created earlier in the run). */
  execute(ctx: Ctx, change: Change, scratch: Map<string, unknown>): Promise<string | void>;
}

export const PLAN_TTL_MS = 15 * 60 * 1000;
const key = (c: Change) => `${c.op}|${c.target}`;
const publicChange = (c: Change) => ({ op: c.op, target: c.target, summary: c.summary });

export async function createPlan<I>(ctx: Ctx, kind: PlanKind<I>, input: I) {
  const result = await kind.compute(ctx, input);
  const now = ctx.now?.() ?? new Date();
  const base = { kind: kind.kind, warnings: result.warnings, ...(result.info ? { info: result.info } : {}) };

  if (result.changes.length === 0) {
    return { ...base, plan_id: null, message: "Nothing to change through the API.", changes: [] };
  }

  const plan = {
    id: newId("pln"),
    kind: kind.kind,
    input,
    changes: result.changes,
    changes_hash: sha256(result.changes),
    confirm_code: newConfirmCode(kind.codePrefix),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    status: "pending" as const,
    done: [],
  };
  ctx.db.insertPlan(plan);
  ctx.db.audit({ actor: ctx.actor, tool: `${kind.kind}:plan`, plan_id: plan.id, target: null, result: "planned", detail: countBy(plan.changes, (c) => c.op) });

  return {
    ...base,
    plan_id: plan.id,
    confirm_code: plan.confirm_code,
    expires_at: plan.expires_at,
    summary: countBy(plan.changes, (c) => c.op),
    changes: plan.changes.map(publicChange),
    next: `Review the changes, then call the apply tool with plan_id "${plan.id}" and confirm_code "${plan.confirm_code}".`,
  };
}

export async function applyPlan<I>(ctx: Ctx, kind: PlanKind<I>, planId: string, confirmCode: string) {
  const plan = ctx.db.getPlan(planId);
  if (!plan) throw new UserError(`Unknown plan "${planId}".`);
  if (plan.kind !== kind.kind) throw new UserError(`Plan ${planId} is a ${plan.kind} plan, not ${kind.kind}.`);
  if (plan.status === "done") throw new UserError(`Plan ${planId} was already applied. Make a new plan.`);
  const now = ctx.now?.() ?? new Date();
  if (now.toISOString() > plan.expires_at) throw new UserError(`Plan ${planId} expired at ${plan.expires_at}. Make a new plan.`);
  if (confirmCode.trim().toUpperCase() !== plan.confirm_code) throw new UserError("confirm_code does not match this plan.");

  // Re-plan and require the remaining work to be exactly what was approved.
  const done = new Set(plan.done);
  const remaining = plan.changes.filter((c) => !done.has(key(c)));
  const fresh = await kind.compute(ctx, plan.input as I);
  if (sha256(fresh.changes) !== sha256(remaining)) {
    const want = new Set(remaining.map(key));
    const got = new Set(fresh.changes.map(key));
    throw new UserError(
      "GitHub or the sheet changed since this plan was made, so it was not applied. Make a new plan.\n" +
        JSON.stringify({ no_longer_needed: [...want].filter((k) => !got.has(k)), newly_needed: [...got].filter((k) => !want.has(k)) }, null, 2),
    );
  }

  const scratch = new Map<string, unknown>();
  const applied: { op: string; target: string; note?: string }[] = [];
  const delay = Math.min(ctx.ev.cfg.write_delay_ms, kind.writeDelayMs ?? Number.POSITIVE_INFINITY);

  for (const [i, change] of remaining.entries()) {
    if (i > 0) await sleep(delay);
    try {
      const note = await kind.execute(ctx, change, scratch);
      done.add(key(change));
      applied.push({ op: change.op, target: change.target, ...(note ? { note } : {}) });
      ctx.db.audit({ actor: ctx.actor, tool: `${kind.kind}:apply`, plan_id: plan.id, target: change.target, result: "ok", detail: { op: change.op, note } });
    } catch (err) {
      const message = errorMessage(err);
      ctx.db.updatePlanProgress(plan.id, "partial", [...done]);
      ctx.db.audit({ actor: ctx.actor, tool: `${kind.kind}:apply`, plan_id: plan.id, target: change.target, result: "error", detail: { op: change.op, error: message } });
      return {
        status: "partial",
        plan_id: plan.id,
        applied,
        failed: { ...publicChange(change), error: message },
        remaining: remaining.slice(i + 1).map(publicChange),
        next: "Fix the cause, then call apply again with the same plan_id and confirm_code. Only the remaining changes run.",
      };
    }
  }

  ctx.db.updatePlanProgress(plan.id, "done", [...done]);
  return { status: "done", plan_id: plan.id, applied };
}
