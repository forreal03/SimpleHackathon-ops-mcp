import type { RepoPermission } from "../github/api.js";
import { UserError } from "../lib/util.js";
import type { Change, Ctx, PlanKind } from "./engine.js";
import { lenientRoster, rank, resolveTeam, selectTeams, sortChanges } from "./common.js";

export interface FreezeInput {
  team_nos?: string[];
  archive?: boolean;
  unfreeze?: boolean;
}

export const submissionTag = (ctx: Ctx) => `submission-${ctx.ev.id}`;

/**
 * Freeze: team -> pull, leader -> pull, tag the default branch HEAD as the submission, optionally archive.
 * The tag is taken after permissions drop, so it is the code that gets judged. Installed apps can still
 * push until the repo is archived, which is why judging always uses the tag.
 * Unfreeze: unarchive, restore team and leader permissions. The tag stays.
 */
export const freezePlan: PlanKind<FreezeInput> = {
  kind: "freeze",
  codePrefix: "FREEZE",

  async compute(ctx, input) {
    const { gh, ev } = ctx;
    const cfg = ev.cfg;
    const roster = await lenientRoster(ctx);
    const teams = selectTeams(ctx, roster, input.team_nos?.length ? input.team_nos : "all");
    const ghTeams = new Map((await gh.listTeams()).map((t) => [t.name.toLowerCase(), t]));
    const tag = submissionTag(ctx);
    const changes: Change[] = [];
    const warnings: string[] = [];

    for (const team of teams) {
      const name = team.repo_name;
      const repo = await gh.getRepo(name);
      if (!repo) {
        warnings.push(`${name} does not exist; skipped.`);
        continue;
      }
      const t = `repo:${name}`;
      const ghTeam = ghTeams.get(team.team_name.toLowerCase());
      const leader = team.leader?.github_login ?? null;

      if (input.unfreeze) {
        if (repo.archived) changes.push({ op: "unarchive", target: t, summary: `Unarchive ${name}`, params: { repo: name } });
        if (ghTeam) {
          const cur = await gh.getTeamRepoPermission(ghTeam.slug, name);
          if (cur !== cfg.repo.member_permission) {
            changes.push({ op: "set_team_permission", target: `${t}/team:${team.team_name}`, summary: `Restore ${team.team_name} to ${cfg.repo.member_permission} on ${name}`, params: { team_name: team.team_name, repo: name, permission: cfg.repo.member_permission } });
          }
        }
        if (leader && rank(await gh.getUserRepoPermission(name, leader)) < rank(cfg.repo.leader_permission)) {
          changes.push({ op: "set_collaborator", target: `${t}/user:${leader}`, summary: `Restore leader @${leader} to ${cfg.repo.leader_permission} on ${name}`, params: { repo: name, login: leader, permission: cfg.repo.leader_permission } });
        }
        continue;
      }

      if (repo.archived) {
        warnings.push(`${name} is already archived.`);
        continue;
      }
      if (!ghTeam) warnings.push(`GitHub team ${team.team_name} not found; only the tag is planned for ${name}.`);
      else {
        const cur = await gh.getTeamRepoPermission(ghTeam.slug, name);
        if (cur && cur !== "pull") {
          changes.push({ op: "set_team_permission", target: `${t}/team:${team.team_name}`, summary: `Lower ${team.team_name} to pull (read) on ${name}`, params: { team_name: team.team_name, repo: name, permission: "pull" } });
        }
      }
      if (leader) {
        const role = await gh.getUserRepoPermission(name, leader);
        if (role === "admin") warnings.push(`@${leader} is an admin of ${name} (org owner?) and cannot be restricted.`);
        else if (rank(role) > rank("pull")) {
          changes.push({ op: "set_collaborator", target: `${t}/user:${leader}`, summary: `Lower leader @${leader} to pull on ${name}`, params: { repo: name, login: leader, permission: "pull" } });
        }
      }
      if (await gh.getRefSha(name, `tags/${tag}`)) {
        warnings.push(`${name} already has tag ${tag}; it is kept as is.`);
      } else if (!(await gh.getRefSha(name, `heads/${repo.default_branch}`))) {
        warnings.push(`${name} has no commits on ${repo.default_branch}; no tag.`);
      } else {
        changes.push({ op: "create_tag", target: `${t}/tag`, summary: `Tag ${repo.default_branch} HEAD of ${name} as ${tag} (taken at apply time)`, params: { repo: name, tag, branch: repo.default_branch } });
      }
      if (input.archive) changes.push({ op: "archive", target: t, summary: `Archive ${name} (read-only for everyone, apps included)`, params: { repo: name } });
    }

    if (input.archive && !input.unfreeze) {
      warnings.push("Archived repos cannot change visibility until unarchived. If they should go public, run repos_visibility first (it handles archived repos too).");
    }
    return { changes: sortChanges(changes, true), warnings };
  },

  async execute(ctx, change, scratch) {
    const p = change.params as { repo: string; team_name?: string; login?: string; permission?: RepoPermission; tag?: string; branch?: string };
    const gh = ctx.gh;
    switch (change.op) {
      case "set_team_permission":
        return gh.setTeamRepoPermission((await resolveTeam(ctx, scratch, p.team_name!)).slug, p.repo, p.permission!);
      case "set_collaborator":
        return gh.setCollaborator(p.repo, p.login!, p.permission!);
      case "create_tag": {
        const sha = await gh.getRefSha(p.repo, `heads/${p.branch}`);
        if (!sha) throw new UserError(`${p.repo} has no commits on ${p.branch}.`);
        await gh.createRef(p.repo, `tags/${p.tag}`, sha);
        return `tagged ${sha.slice(0, 7)}`;
      }
      case "archive":
        return gh.updateRepo(p.repo, { archived: true });
      case "unarchive":
        return gh.updateRepo(p.repo, { archived: false });
      default:
        throw new Error(`unknown op ${change.op}`);
    }
  },
};
