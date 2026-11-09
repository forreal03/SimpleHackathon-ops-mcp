import { checkReadme, findSecretFiles } from "../repos/checks.js";
import type { Change, PlanKind } from "./engine.js";
import { sortChanges } from "./common.js";
import { deadlineOf, discoverRepos } from "../repos/discover.js";
import { untrusted, UserError } from "../lib/util.js";

/** Set while this tool has a repo unarchived to switch it, so an interrupted run still re-archives it. */
const UNARCHIVED = "unarchived_for_visibility";

export interface VisibilityInput {
  track?: string;
  team_nos?: string[];
  visibility: "public" | "private";
  /** Repos to make public even though secret-looking files were found (after a human checked them). */
  force_repos?: string[];
  /** Go public although a deadline has not passed (the repo's own, or another track's). */
  allow_while_running?: boolean;
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
    const repos = await discoverRepos(ctx, { track: input.track, team_nos: input.team_nos });
    const now = ctx.now?.() ?? new Date();
    const notDue: { repo: string; deadline: string }[] = [];

    if (input.visibility === "public" && !input.allow_while_running) {
      // Public means every participant, other tracks included, can read it.
      const selected = new Set(repos.map((r) => r.track));
      const running = Object.keys(ev.cfg.tracks)
        .filter((k) => !selected.has(k))
        .map((k) => [k, deadlineOf(ev.cfg, k)] as const)
        .filter(([, d]) => d && now < new Date(d));
      if (running.length) {
        throw new UserError(
          `Track ${running.map(([k, d]) => `${k} (deadline ${d})`).join(", ")} is still running; its teams could read these repos once public. ` +
            "Wait for that deadline, or pass allow_while_running if that is intended.",
        );
      }
    }
    const force = new Set((input.force_repos ?? []).map((r) => r.toLowerCase()));
    const required = ev.cfg.repo.readme_required_sections;

    const changes: Change[] = [];
    const warnings: string[] = [];
    const blocked: { repo: string; files: { path: string; why: string }[] }[] = [];
    const readme: { repo: string; missing: string[]; empty: string[]; has_readme: boolean }[] = [];
    const links: { team_no: string; repo: string; url: string }[] = [];

    for (const found of repos) {
      const name = found.name;
      const repo = found.repo;
      links.push({ team_no: found.team_no, repo: name, url: repo.html_url });
      const wasArchived = repo.archived || ctx.db.hasFlag(name, UNARCHIVED);
      const t = `repo:${name}`;
      if (repo.visibility === input.visibility) {
        // An earlier run switched it but stopped before archiving it again.
        if (wasArchived && !repo.archived) changes.push({ op: "archive", target: t, summary: `Archive ${name} again`, params: { repo: name } });
        continue;
      }

      const deadline = deadlineOf(ev.cfg, found.track);
      if (input.visibility === "public" && !input.allow_while_running && deadline && now < new Date(deadline)) {
        notDue.push({ repo: name, deadline });
        continue;
      }

      if (input.visibility === "public") {
        const tree = await gh.getTree(name, repo.default_branch);
        if (tree.truncated) warnings.push(`${name}: file list was truncated by GitHub; the secret scan is incomplete.`);
        const hits = findSecretFiles(tree.paths);
        if (hits.length && !force.has(name.toLowerCase())) {
          blocked.push({ repo: name, files: hits.map((h) => ({ path: untrusted(h.path, 160), why: h.why })) });
          continue;
        }
        const report = checkReadme(await gh.getReadme(name), required);
        if (!report.has_readme || report.missing.length || report.empty.length) readme.push({ repo: name, ...report });
      }

      if (repo.archived) changes.push({ op: "unarchive", target: t, summary: `Unarchive ${name} (to change visibility)`, params: { repo: name } });
      changes.push({ op: "set_visibility", target: t, summary: `Make ${name} ${input.visibility}`, params: { repo: name, visibility: input.visibility } });
      if (wasArchived) changes.push({ op: "archive", target: t, summary: `Archive ${name} again`, params: { repo: name } });
    }

    if (blocked.length) {
      warnings.push(
        `${blocked.length} repo(s) were left out because they contain secret-looking files. ` +
          "Ask the team to delete the file AND rotate the key (it stays in git history), or pass the repo in force_repos after checking.",
      );
    }
    if (notDue.length) {
      warnings.push(`${notDue.length} repo(s) left private because their deadline has not passed: ${notDue.map((n) => `${n.repo} (${n.deadline})`).join(", ")}. Pass allow_while_running to switch them anyway.`);
    }
    if (input.visibility === "public") {
      warnings.push("Anything public can be cloned or forked while it is public. Making it private later does not take those copies back.");
    }

    return { changes: sortChanges(changes, true), warnings, info: { blocked, not_yet_due: notDue, readme_gaps: readme, repo_links: links, org_url: `https://github.com/${ev.cfg.github.org}` } };
  },

  async execute(ctx, change) {
    const p = change.params as { repo: string; visibility?: "public" | "private" };
    switch (change.op) {
      case "unarchive":
        ctx.db.setFlag(p.repo, UNARCHIVED);
        return ctx.gh.updateRepo(p.repo, { archived: false });
      case "set_visibility":
        return ctx.gh.updateRepo(p.repo, { visibility: p.visibility! });
      case "archive":
        await ctx.gh.updateRepo(p.repo, { archived: true });
        ctx.db.clearFlag(p.repo, UNARCHIVED);
        return;
      default:
        throw new Error(`unknown op ${change.op}`);
    }
  },
};
