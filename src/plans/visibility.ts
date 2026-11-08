import { checkReadme, findSecretFiles } from "../repos/checks.js";
import type { Change, PlanKind } from "./engine.js";
import { lenientRoster, selectTeams, sortChanges } from "./common.js";

export interface VisibilityInput {
  team_nos?: string[];
  visibility: "public" | "private";
  /** Repos to make public even though secret-looking files were found (after a human checked them). */
  force_repos?: string[];
}

/**
 * Toggle repos public/private. Going public first scans each repo for secret-looking files
 * (blocks that repo) and for empty README sections (warning only).
 * Archived repos are unarchived, switched and archived again.
 */
export const visibilityPlan: PlanKind<VisibilityInput> = {
  kind: "visibility",
  codePrefix: "PUBLIC",

  async compute(ctx, input) {
    const { gh, ev } = ctx;
    const roster = await lenientRoster(ctx);
    const teams = selectTeams(ctx, roster, input.team_nos?.length ? input.team_nos : "all");
    const force = new Set((input.force_repos ?? []).map((r) => r.toLowerCase()));
    const required = ev.cfg.repo.readme_required_sections;

    const changes: Change[] = [];
    const warnings: string[] = [];
    const blocked: { repo: string; files: { path: string; why: string }[] }[] = [];
    const readme: { repo: string; missing: string[]; empty: string[]; has_readme: boolean }[] = [];
    const links: { team_no: string; repo: string; url: string }[] = [];

    for (const team of teams) {
      const name = team.repo_name;
      const repo = await gh.getRepo(name);
      if (!repo) {
        warnings.push(`${name} does not exist; skipped.`);
        continue;
      }
      links.push({ team_no: team.team_no, repo: name, url: repo.html_url });
      if (repo.visibility === input.visibility) continue;

      if (input.visibility === "public") {
        const tree = await gh.getTree(name, repo.default_branch);
        if (tree.truncated) warnings.push(`${name}: file list was truncated by GitHub; the secret scan is incomplete.`);
        const hits = findSecretFiles(tree.paths);
        if (hits.length && !force.has(name.toLowerCase())) {
          blocked.push({ repo: name, files: hits });
          continue;
        }
        const report = checkReadme(await gh.getReadme(name), required);
        if (!report.has_readme || report.missing.length || report.empty.length) readme.push({ repo: name, ...report });
      }

      const t = `repo:${name}`;
      if (repo.archived) changes.push({ op: "unarchive", target: t, summary: `Unarchive ${name} (to change visibility)`, params: { repo: name } });
      changes.push({ op: "set_visibility", target: t, summary: `Make ${name} ${input.visibility}`, params: { repo: name, visibility: input.visibility } });
      if (repo.archived) changes.push({ op: "archive", target: t, summary: `Archive ${name} again`, params: { repo: name } });
    }

    if (blocked.length) {
      warnings.push(
        `${blocked.length} repo(s) were left out because they contain secret-looking files. ` +
          "Ask the team to delete the file AND rotate the key (it stays in git history), or pass the repo in force_repos after checking.",
      );
    }
    if (input.visibility === "public") {
      warnings.push("Anything public can be cloned or forked while it is public. Making it private later does not take those copies back.");
    }

    return { changes: sortChanges(changes, true), warnings, info: { blocked, readme_gaps: readme, repo_links: links, org_url: `https://github.com/${ev.cfg.github.org}` } };
  },

  async execute(ctx, change) {
    const p = change.params as { repo: string; visibility?: "public" | "private" };
    switch (change.op) {
      case "unarchive":
        return ctx.gh.updateRepo(p.repo, { archived: false });
      case "set_visibility":
        return ctx.gh.updateRepo(p.repo, { visibility: p.visibility! });
      case "archive":
        return ctx.gh.updateRepo(p.repo, { archived: true });
      default:
        throw new Error(`unknown op ${change.op}`);
    }
  },
};
