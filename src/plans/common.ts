import type { TeamInfo } from "../github/api.js";
import { loadRoster, type Roster, type Team } from "../roster/roster.js";
import { normTeamNo, UserError } from "../lib/util.js";
import type { Ctx } from "./engine.js";

export const RANK: Record<string, number> = { none: 0, pull: 1, triage: 2, push: 3, maintain: 4, admin: 5 };
export const rank = (role: string | null | undefined) => RANK[role ?? "none"] ?? 0;

/** Roster for steps that create things: refuses while the sheet has errors. */
export async function strictRoster(ctx: Ctx): Promise<Roster> {
  const roster = await loadRoster(ctx.ev, ctx.read);
  const errors = roster.problems.filter((p) => p.severity === "error");
  if (errors.length) {
    throw new UserError(
      "The roster has errors. Fix the sheet and run roster_sync until it reports none:\n" +
        errors.map((e) => `  - [${e.kind}] ${e.message}${e.people?.length ? ` (${e.people.join(", ")})` : ""}`).join("\n"),
    );
  }
  return roster;
}

/** Roster for steps that only touch existing repos (freeze, visibility, activity): sheet errors are tolerated. */
export async function lenientRoster(ctx: Ctx): Promise<Roster> {
  return loadRoster(ctx.ev, ctx.read);
}

export function selectTeams(ctx: Ctx, roster: Roster, teamNos?: string[] | "all"): Team[] {
  if (!teamNos || teamNos === "all") return roster.teams;
  const wanted = new Set(teamNos.map((n) => normTeamNo(n, ctx.ev.cfg.github.team_no_pad)));
  const picked = roster.teams.filter((t) => wanted.has(t.team_no));
  const unknown = [...wanted].filter((n) => !picked.some((t) => t.team_no === n));
  if (unknown.length) throw new UserError(`Unknown team number(s): ${unknown.join(", ")}.`);
  return picked;
}

export async function teamsByName(ctx: Ctx): Promise<Map<string, TeamInfo>> {
  return new Map((await ctx.gh.listTeams()).map((t) => [t.name.toLowerCase(), t]));
}

/** Looks a team up by name during apply, refreshing once if it was created earlier in the run. */
export async function resolveTeam(ctx: Ctx, scratch: Map<string, unknown>, name: string): Promise<TeamInfo> {
  let map = scratch.get("teams") as Map<string, TeamInfo> | undefined;
  if (!map || !map.has(name.toLowerCase())) {
    map = await teamsByName(ctx);
    scratch.set("teams", map);
  }
  const team = map.get(name.toLowerCase());
  if (!team) throw new UserError(`GitHub team "${name}" does not exist.`);
  return team;
}

export function rememberTeam(scratch: Map<string, unknown>, team: TeamInfo) {
  const map = (scratch.get("teams") as Map<string, TeamInfo> | undefined) ?? new Map<string, TeamInfo>();
  map.set(team.name.toLowerCase(), team);
  scratch.set("teams", map);
}

/** Runs `fn` over items with limited concurrency, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const OP_ORDER = [
  "create_team",
  "unarchive",
  "remove_membership",
  "add_membership",
  "invite",
  "invite_email",
  "create_repo",
  "set_team_permission",
  "set_collaborator",
  "create_ruleset",
  "set_topics",
  "create_tag",
  "set_visibility",
  "add_collaborator",
  "remove_collaborator",
  "delete_invitation",
  "archive",
];

/** Deterministic order so a re-plan hashes the same. */
export function sortChanges<T extends { op: string; target: string }>(changes: T[], groupByRepo = false): T[] {
  const opIdx = (op: string) => {
    const i = OP_ORDER.indexOf(op);
    return i === -1 ? OP_ORDER.length : i;
  };
  const repoOf = (t: string) => t.match(/^repo:([^/#]+)/)?.[1] ?? "";
  return [...changes].sort((a, b) => {
    if (groupByRepo) {
      const r = repoOf(a.target).localeCompare(repoOf(b.target), "en", { numeric: true });
      if (r !== 0) return r;
    }
    return opIdx(a.op) - opIdx(b.op) || a.target.localeCompare(b.target, "en", { numeric: true });
  });
}
