import { isStatus, type RepoPermission } from "../github/api.js";
import { fill, sleep, UserError } from "../lib/util.js";
import type { Change, Ctx, PlanKind } from "./engine.js";
import { rank, resolveTeam, selectTeams, sortChanges, strictRoster } from "./common.js";

export const RULESET_NAME = "hackathon-ops";
const UNSUPPORTED = "ruleset_unsupported";

export function topicsFor(ctx: Ctx): string[] {
  return ctx.ev.cfg.repo.topics
    .map((t) =>
      fill(t, { event_id: ctx.ev.id })
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50),
    )
    .filter(Boolean);
}

export function rulesetBody(ctx: Ctx): Record<string, unknown> {
  const r = ctx.ev.cfg.repo.ruleset;
  const rules: { type: string }[] = [];
  if (r.block_deletion) rules.push({ type: "deletion" });
  if (r.block_force_push) rules.push({ type: "non_fast_forward" });
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules,
  };
}

/** Desired: one repo per team (from the track template), team write access, leader maintain, ruleset, topics. */
export const reposPlan: PlanKind<{ team_nos?: string[] }> = {
  kind: "repos",
  codePrefix: "REPOS",

  async compute(ctx, input) {
    const { gh, ev } = ctx;
    const cfg = ev.cfg;
    const roster = await strictRoster(ctx);
    const teams = selectTeams(ctx, roster, input.team_nos?.length ? input.team_nos : "all");

    const [ghTeams, members] = await Promise.all([gh.listTeams(), gh.listOrgMembers()]);
    const teamByName = new Map(ghTeams.map((t) => [t.name.toLowerCase(), t]));
    const orgMembers = new Set(members.map((m) => m.toLowerCase()));
    const topics = topicsFor(ctx);

    const templates = [...new Set(teams.map((t) => t.template).filter((t): t is string => !!t))];
    for (const tpl of templates) {
      const info = await gh.getTemplate(tpl);
      if (!info) throw new UserError(`Template repo ${tpl} does not exist or the GitHub App cannot see it.`);
      if (!info.is_template) throw new UserError(`${tpl} is not marked as a template repository (Settings → Template repository).`);
    }

    const changes: Change[] = [];
    const warnings: string[] = [];

    for (const team of teams) {
      const name = team.repo_name;
      const repo = await gh.getRepo(name);
      const ghTeam = teamByName.get(team.team_name.toLowerCase());
      const t = `repo:${name}`;

      if (!repo) {
        changes.push({
          op: "create_repo",
          target: t,
          summary: `Create ${cfg.repo.visibility} repo ${name}${team.template ? ` from ${team.template}` : " (empty)"}`,
          params: { name, template: team.template, private: cfg.repo.visibility === "private", description: `${ev.id} · ${team.team_name}` },
        });
      } else if (repo.archived) {
        warnings.push(`${name} is archived; skipped. Unfreeze it first if it should be active.`);
        continue;
      }

      if (!ghTeam) {
        warnings.push(`GitHub team ${team.team_name} does not exist yet; its access to ${name} is not planned. Run teams_apply, then repos_plan again.`);
      } else {
        const current = repo ? await gh.getTeamRepoPermission(ghTeam.slug, name) : null;
        if (current !== cfg.repo.member_permission) {
          changes.push({
            op: "set_team_permission",
            target: `${t}/team:${team.team_name}`,
            summary: `Give team ${team.team_name} ${cfg.repo.member_permission} on ${name}${current ? ` (now ${current})` : ""}`,
            params: { team_name: team.team_name, repo: name, permission: cfg.repo.member_permission },
          });
        }
      }

      const leader = team.leader?.github_login;
      if (leader) {
        if (!orgMembers.has(leader.toLowerCase())) {
          warnings.push(`Leader @${leader} of ${team.team_name} is not an org member yet; leader access to ${name} is planned after they accept.`);
        } else {
          const role = repo ? await gh.getUserRepoPermission(name, leader) : "none";
          if (rank(role) < rank(cfg.repo.leader_permission)) {
            changes.push({
              op: "set_collaborator",
              target: `${t}/user:${leader}`,
              summary: `Give leader @${leader} ${cfg.repo.leader_permission} on ${name}`,
              params: { repo: name, login: leader, permission: cfg.repo.leader_permission },
            });
          }
        }
      }

      if (cfg.repo.ruleset.enabled) {
        if (ctx.db.hasFlag(name, UNSUPPORTED)) {
          warnings.push(`${name}: rulesets are not available for private repos on this org's plan; skipped.`);
        } else {
          let has = false;
          if (repo) {
            try {
              has = (await gh.listRulesets(name)).some((r) => r.name === RULESET_NAME);
            } catch (err) {
              if (!isStatus(err, 403, 404)) throw err;
              ctx.db.setFlag(name, UNSUPPORTED);
              warnings.push(`${name}: rulesets are not available for private repos on this org's plan; skipped.`);
              has = true;
            }
          }
          if (!has) {
            changes.push({ op: "create_ruleset", target: `${t}/ruleset`, summary: `Protect the default branch of ${name} (no deletion, no force push)`, params: { repo: name } });
          }
        }
      }

      if (topics.length) {
        const now = repo ? await gh.getTopics(name) : [];
        const union = [...new Set([...now, ...topics])].sort();
        if (union.length !== now.length) {
          changes.push({ op: "set_topics", target: `${t}/topics`, summary: `Set topics on ${name}: ${union.join(", ")}`, params: { repo: name, names: union } });
        }
      }
    }

    return { changes: sortChanges(changes, true), warnings };
  },

  async execute(ctx, change, scratch) {
    const p = change.params as { name?: string; template?: string | null; private?: boolean; description?: string; repo?: string; team_name?: string; login?: string; permission?: RepoPermission; names?: string[] };
    const gh = ctx.gh;
    switch (change.op) {
      case "create_repo": {
        if (p.template) await gh.createRepoFromTemplate(p.template, p.name!, !!p.private, p.description ?? "");
        else await gh.createRepo(p.name!, !!p.private, p.description ?? "");
        // Template generation is asynchronous; wait until the repo answers.
        for (let i = 0; i < 10 && !(await gh.getRepo(p.name!)); i++) await sleep(1000);
        return;
      }
      case "set_team_permission":
        return gh.setTeamRepoPermission((await resolveTeam(ctx, scratch, p.team_name!)).slug, p.repo!, p.permission!);
      case "set_collaborator":
        return gh.setCollaborator(p.repo!, p.login!, p.permission!);
      case "create_ruleset":
        try {
          await gh.createRuleset(p.repo!, rulesetBody(ctx));
          return;
        } catch (err) {
          if (!isStatus(err, 403, 422)) throw err;
          ctx.db.setFlag(p.repo!, UNSUPPORTED);
          return "skipped: rulesets on private repos need a paid plan (they work once the repo is public)";
        }
      case "set_topics":
        return gh.setTopics(p.repo!, p.names!);
      default:
        throw new Error(`unknown op ${change.op}`);
    }
  },
};
