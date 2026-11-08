import type { ReviewerRow } from "../state/db.js";
import { discoverRepos, participantTeams, type EventRepo } from "../repos/discover.js";
import { normLogin, normTeamNo, UserError } from "../lib/util.js";
import type { Change, Ctx, PlanKind } from "./engine.js";
import { rank, sortChanges } from "./common.js";

export interface ReviewersInput {
  /** sync: make GitHub match the registered reviewers. revoke_all: remove every registered reviewer everywhere. */
  action: "sync" | "revoke_all";
}

/** Repos a reviewer should be able to read: their teams' repos, or every event repo when scope is "all". */
export function reposFor(r: ReviewerRow, repos: EventRepo[]): EventRepo[] {
  return r.scope === "all" ? repos : repos.filter((x) => r.teams.includes(x.team_no));
}

/** Why a participant cannot have this assignment, or null when it is fine (only their own team). */
export function participantConflict(r: Pick<ReviewerRow, "login" | "scope" | "teams">, own: string[] | undefined): string | null {
  if (!own?.length) return null;
  if (r.scope === "all") return `@${r.login} is a participant (team ${own.join(", ")}); "all" would show them every other team's code.`;
  const other = r.teams.filter((t) => !own.includes(t));
  return other.length ? `@${r.login} is a participant (team ${own.join(", ")}) and cannot see team ${other.join(", ")}.` : null;
}

/**
 * Mentors and judges get read (pull) access as outside collaborators, repo by repo. Never org members,
 * never more than read. Public repos are left alone: anyone can already read them.
 */
export const reviewersPlan: PlanKind<ReviewersInput> = {
  kind: "reviewers",
  codePrefix: "REVIEW",

  async compute(ctx, input) {
    const { gh, ev, db } = ctx;
    const rows = db.reviewers();
    if (rows.length === 0) throw new UserError("No mentors or judges are registered. Add them with reviewer_set first.");
    const repos = await discoverRepos(ctx);
    const members = new Set((await gh.listOrgMembers()).map((m) => m.toLowerCase()));
    const managed = new Set(rows.map((r) => r.login.toLowerCase()));
    const playing = await participantTeams(ctx);
    const warnings: string[] = [];
    // A registered reviewer who has since joined a team must not keep cross-team access.
    const active = (input.action === "sync" ? rows.filter((r) => r.active) : []).filter((r) => {
      const conflict = participantConflict(r, playing.get(r.login.toLowerCase()));
      if (conflict) warnings.push(`Skipped: ${conflict} Fix it with reviewer_set or reviewer_remove.`);
      return !conflict;
    });

    const want = new Map<string, Set<string>>();
    for (const r of active) for (const repo of reposFor(r, repos)) want.set(repo.name, (want.get(repo.name) ?? new Set()).add(r.login));

    const changes: Change[] = [];
    const leftOnPublic: string[] = [];

    for (const repo of repos) {
      const name = repo.name;
      const isPublic = repo.repo.visibility === "public";
      const desired = want.get(name) ?? new Set<string>();
      const outside = new Set((await gh.listOutsideCollaborators(name)).map((l) => l.toLowerCase()));
      const invites = await gh.listRepoInvitations(name);
      const invited = new Set(invites.flatMap((i) => (i.login ? [i.login.toLowerCase()] : [])));

      for (const login of desired) {
        const l = login.toLowerCase();
        if (isPublic || outside.has(l) || invited.has(l)) continue;
        const role = await gh.getUserRepoPermission(name, login);
        if (role === null) {
          warnings.push(`GitHub user @${login} does not exist.`);
          continue;
        }
        if (rank(role) >= rank("pull")) {
          if (members.has(l)) warnings.push(`@${login} is an org member and already has ${role} on ${name}.`);
          continue;
        }
        changes.push({ op: "add_collaborator", target: `repo:${name}/user:${login}`, summary: `Give @${login} read access to ${name}`, params: { repo: name, login } });
      }

      const keep = new Set([...desired].map((l) => l.toLowerCase()));
      for (const l of outside) {
        if (!managed.has(l) || keep.has(l)) continue;
        if (isPublic && input.action === "sync") {
          leftOnPublic.push(`@${l} on ${name}`);
          continue;
        }
        changes.push({ op: "remove_collaborator", target: `repo:${name}/user:${l}`, summary: `Remove @${l} from ${name}`, params: { repo: name, login: l } });
      }
      for (const inv of invites) {
        const l = inv.login?.toLowerCase();
        if (!l || !managed.has(l) || keep.has(l)) continue;
        if (isPublic && input.action === "sync") continue;
        changes.push({ op: "delete_invitation", target: `repo:${name}/invitation:${l}`, summary: `Cancel the pending invitation for @${l} to ${name}`, params: { repo: name, id: inv.id } });
      }
    }

    if (leftOnPublic.length) warnings.push(`Public repos are left as they are; existing access kept for ${leftOnPublic.join(", ")}. Use revoke_all to remove it.`);
    const expires = ev.cfg.reviewers.expires_at;
    if (input.action === "sync" && expires && new Date(expires) < (ctx.now?.() ?? new Date())) {
      warnings.push(`reviewers.expires_at (${expires}) has passed. You probably want revoke_all.`);
    }
    for (const r of active) if (members.has(r.login.toLowerCase())) warnings.push(`${r.name || "@" + r.login} is an org member, so teams may give them more than read.`);

    const links = active.map((r) => ({
      name: r.name,
      github_login: r.login,
      role: r.role,
      scope: r.scope,
      repos: reposFor(r, repos).map((x) => ({ repo: x.name, url: x.repo.html_url, public: x.repo.visibility === "public" })),
    }));
    if (input.action === "sync" && changes.some((c) => c.op === "add_collaborator")) {
      warnings.push("Each person must accept the GitHub invitation (email or github.com/notifications) before the links work.");
    }
    return { changes: sortChanges(changes), warnings, info: input.action === "sync" ? { links } : undefined };
  },

  async execute(ctx, change) {
    const p = change.params as { repo: string; login?: string; id?: number };
    switch (change.op) {
      case "add_collaborator":
        // Always pull. Not configurable on purpose.
        return ctx.gh.setCollaborator(p.repo, p.login!, "pull");
      case "remove_collaborator":
        return ctx.gh.removeCollaborator(p.repo, p.login!);
      case "delete_invitation":
        return ctx.gh.deleteRepoInvitation(p.repo, p.id!);
      default:
        throw new Error(`unknown op ${change.op}`);
    }
  },
};

// ---------------------------------------------------------------- registry (local, no GitHub writes)

export async function reviewerSet(
  ctx: Ctx,
  a: { github_login: string; name?: string; role: "mentor" | "judge"; scope?: "team" | "all"; teams?: string[] },
) {
  const login = normLogin(a.github_login);
  if (!login) throw new UserError(`"${a.github_login}" is not a GitHub username.`);
  const user = await ctx.gh.getUser(login);
  if (!user) throw new UserError(`GitHub user @${login} does not exist.`);
  if (user.type !== "User") throw new UserError(`@${login} is a ${user.type}, not a person.`);

  const existing = ctx.db.reviewers().find((r) => r.login.toLowerCase() === user.login.toLowerCase());
  const scope = a.scope ?? existing?.scope ?? (a.role === "judge" ? "all" : "team");
  const teams = a.teams ? a.teams.map((t) => normTeamNo(t, ctx.ev.cfg.github.team_no_pad)) : existing?.teams ?? [];
  if (scope === "team" && teams.length === 0) throw new UserError('With scope "team", give the team numbers this person may see (e.g. ["03"]).');
  if (teams.length) {
    const known = new Set((await discoverRepos(ctx)).map((r) => r.team_no));
    const unknown = teams.filter((t) => !known.has(t));
    if (unknown.length) throw new UserError(`No repo for team(s) ${unknown.join(", ")}.`);
  }

  const conflict = participantConflict({ login: user.login, scope, teams }, (await participantTeams(ctx)).get(user.login.toLowerCase()));
  if (conflict) throw new UserError(`${conflict} Participants can only be given their own team.`);

  const row = { login: user.login, name: a.name ?? existing?.name ?? "", role: a.role, scope, teams, active: true };
  ctx.db.upsertReviewer(row);
  ctx.db.audit({ actor: ctx.actor, tool: "reviewer_set", plan_id: null, target: `user:${user.login}`, result: "ok", detail: { role: a.role, scope, teams } });
  return {
    saved: row,
    sees: scope === "all" ? "every private event repo (read only)" : `private repos of team(s) ${teams.join(", ")} (read only)`,
    next: "Nothing changed on GitHub yet. Run reviewers_plan with action sync, then reviewers_apply.",
  };
}

export async function reviewerRemove(ctx: Ctx, a: { github_login: string }) {
  const login = normLogin(a.github_login);
  const row = ctx.db.reviewers().find((r) => r.login.toLowerCase() === (login ?? "").toLowerCase());
  if (!row) throw new UserError(`@${a.github_login} is not registered.`);
  ctx.db.upsertReviewer({ ...row, active: false });
  ctx.db.audit({ actor: ctx.actor, tool: "reviewer_remove", plan_id: null, target: `user:${row.login}`, result: "ok", detail: null });
  return { removed: row.login, next: "Run reviewers_plan with action sync to take their access away on GitHub." };
}

export function reviewersRegistry(ctx: Ctx) {
  return ctx.db.reviewers().map((r) => ({ github_login: r.login, name: r.name, role: r.role, scope: r.scope, teams: r.teams, active: r.active, updated_at: r.updated_at }));
}
