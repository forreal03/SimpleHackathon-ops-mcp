import { loadReviewers } from "../roster/roster.js";
import { UserError } from "../lib/util.js";
import type { Change, PlanKind } from "./engine.js";
import { lenientRoster, rank, sortChanges } from "./common.js";

export interface ReviewersInput {
  action: "grant" | "revoke";
}

/**
 * Mentors and judges get read-only (pull) access as outside collaborators on their repos only.
 * They are never added to the org, so they cannot see other repos, teams or settings.
 */
export const reviewersPlan: PlanKind<ReviewersInput> = {
  kind: "reviewers",
  codePrefix: "REVIEW",

  async compute(ctx, input) {
    const { gh, ev } = ctx;
    const roster = await lenientRoster(ctx);
    const { reviewers, problems } = await loadReviewers(ev, roster, ctx.read);
    const errors = problems.filter((p) => p.severity === "error");
    if (errors.length) throw new UserError("The reviewers tab has errors:\n" + errors.map((e) => `  - ${e.message}`).join("\n"));

    const members = new Set((await gh.listOrgMembers()).map((m) => m.toLowerCase()));
    const changes: Change[] = [];
    const warnings: string[] = [];
    const links: { name: string; github_login: string; role: string; repos: string[] }[] = [];
    const repoInfo = new Map<string, Awaited<ReturnType<typeof gh.getRepo>>>();
    const invitations = new Map<string, Awaited<ReturnType<typeof gh.listRepoInvitations>>>();
    const repo = async (n: string) => {
      if (!repoInfo.has(n)) repoInfo.set(n, await gh.getRepo(n));
      return repoInfo.get(n)!;
    };
    const invites = async (n: string) => {
      if (!invitations.has(n)) invitations.set(n, await gh.listRepoInvitations(n));
      return invitations.get(n)!;
    };

    const expires = ev.cfg.reviewers?.expires_at;
    if (input.action === "grant" && expires && new Date(expires) < (ctx.now?.() ?? new Date())) {
      warnings.push(`reviewers.expires_at (${expires}) has passed. You probably want action "revoke".`);
    }

    if (input.action === "grant") {
      for (const r of reviewers) {
        const login = r.github_login;
        if (members.has(login.toLowerCase())) warnings.push(`${r.name} (@${login}) is an org member, so they may see more than their assigned repos.`);
        const teams = r.teams === "all" ? roster.teams : roster.teams.filter((t) => (r.teams as string[]).includes(t.team_no));
        const urls: string[] = [];
        for (const team of teams) {
          const info = await repo(team.repo_name);
          if (!info) continue;
          urls.push(info.html_url);
          const role = await gh.getUserRepoPermission(team.repo_name, login);
          if (role === null) {
            warnings.push(`GitHub user @${login} (${r.name}) does not exist.`);
            break;
          }
          if (rank(role) >= rank("pull")) {
            if (rank(role) > rank("pull") && !members.has(login.toLowerCase())) warnings.push(`@${login} has ${role} on ${team.repo_name}, more than read.`);
            continue;
          }
          if ((await invites(team.repo_name)).some((i) => i.login?.toLowerCase() === login.toLowerCase())) continue;
          changes.push({
            op: "add_collaborator",
            target: `repo:${team.repo_name}/user:${login}`,
            summary: `Give ${r.role} ${r.name} (@${login}) read access to ${team.repo_name}`,
            params: { repo: team.repo_name, login },
          });
        }
        links.push({ name: r.name, github_login: login, role: r.role, repos: urls });
      }
    } else {
      const listed = new Set(reviewers.map((r) => r.github_login.toLowerCase()));
      for (const team of roster.teams) {
        if (!(await repo(team.repo_name))) continue;
        const outside = await gh.listOutsideCollaborators(team.repo_name);
        for (const login of outside) {
          if (listed.has(login.toLowerCase())) {
            changes.push({ op: "remove_collaborator", target: `repo:${team.repo_name}/user:${login}`, summary: `Remove @${login} from ${team.repo_name}`, params: { repo: team.repo_name, login } });
          } else {
            warnings.push(`@${login} is an outside collaborator on ${team.repo_name} but not in the reviewers tab; left as is.`);
          }
        }
        for (const inv of await invites(team.repo_name)) {
          if (inv.login && listed.has(inv.login.toLowerCase())) {
            changes.push({ op: "delete_invitation", target: `repo:${team.repo_name}/invitation:${inv.login}`, summary: `Cancel pending invitation for @${inv.login} to ${team.repo_name}`, params: { repo: team.repo_name, id: inv.id } });
          }
        }
      }
    }

    if (input.action === "grant") warnings.push("Reviewers must accept the GitHub invitation (email or github.com/notifications) before the links work.");
    return { changes: sortChanges(changes), warnings, info: input.action === "grant" ? { links } : undefined };
  },

  async execute(ctx, change) {
    const p = change.params as { repo: string; login?: string; id?: number };
    switch (change.op) {
      case "add_collaborator":
        // Always pull. The permission is not configurable on purpose.
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
