import type { Principal, RepoPermission } from "../github/api.js";
import type { SnapshotRow } from "../state/db.js";
import { deadlineOf, discoverRepos } from "../repos/discover.js";
import { untrusted, UserError } from "../lib/util.js";
import type { Change, Ctx, PlanKind } from "./engine.js";
import { rank, sortChanges } from "./common.js";

export interface FreezeInput {
  /** Freeze one track (e.g. "hackathon"). Omit both track and team_nos for the whole event. */
  track?: string;
  team_nos?: string[];
  /** Tag the default branch HEAD as submission-<event_id> (default true). */
  tag?: boolean;
  /** Archive too: read-only for everyone, installed apps included. Do it after any visibility change. */
  archive?: boolean;
  unfreeze?: boolean;
}

export const submissionTag = (ctx: Ctx) => `submission-${ctx.ev.id}`;

const INVITE_PERM: Record<string, "read" | "triage" | "write" | "maintain" | "admin"> = { pull: "read", triage: "triage", push: "write", maintain: "maintain", admin: "admin" };

/**
 * Freeze works from GitHub alone: every team, direct collaborator and pending invitation with more than
 * read access on an event repo is lowered to read, and the previous permission is saved locally so
 * unfreeze can put back exactly what was there. Org owners keep admin (GitHub does not allow less).
 */
export const freezePlan: PlanKind<FreezeInput> = {
  kind: "freeze",
  codePrefix: "FREEZE",
  // Every team should lose write access at nearly the same moment.
  writeDelayMs: 250,

  async compute(ctx, input) {
    const { gh, ev, db } = ctx;
    const repos = await discoverRepos(ctx, { track: input.track, team_nos: input.team_nos });
    if (repos.length === 0) throw new UserError(`No repos match "${ev.cfg.repo.name_pattern}" in ${ev.cfg.github.org}.`);
    const owners = new Set((await gh.listOrgOwners()).map((o) => o.toLowerCase()));
    const tag = submissionTag(ctx);
    const wantTag = input.tag !== false;
    const changes: Change[] = [];
    const warnings: string[] = [];

    for (const r of repos) {
      const name = r.name;
      const t = `repo:${name}`;

      if (input.unfreeze) {
        if (r.repo.archived) changes.push({ op: "unarchive", target: t, summary: `Unarchive ${name}`, params: { repo: name } });
        const snaps = db.snapshots(name);
        if (snaps.length === 0) {
          if (!r.repo.archived) warnings.push(`${name}: no saved permissions, so nothing to restore (it was not frozen by this tool).`);
          continue;
        }
        const [teams, users, invites] = await Promise.all([gh.listRepoTeams(name), gh.listDirectCollaborators(name), gh.listRepoInvitations(name)]);
        for (const s of snaps) {
          const current =
            s.kind === "team"
              ? teams.find((x) => x.id === s.principal)?.permission
              : s.kind === "user"
                ? users.find((x) => x.id.toLowerCase() === s.principal.toLowerCase())?.permission
                : invites.find((x) => String(x.id) === s.principal)?.permission ?? undefined;
          const who = `${s.kind}:${s.principal}`;
          if (!current) {
            changes.push({ op: "forget_snapshot", target: `${t}/${who}`, summary: `${name}: ${who} no longer has access; drop its saved permission`, params: { ...s } });
          } else if (rank(current) < rank(s.permission)) {
            changes.push({ op: `restore_${s.kind}`, target: `${t}/${who}`, summary: `Restore ${who} to ${s.permission} on ${name} (now ${current})`, params: { ...s } });
          } else {
            changes.push({ op: "forget_snapshot", target: `${t}/${who}`, summary: `${name}: ${who} already has ${current}; drop its saved permission`, params: { ...s } });
          }
        }
        continue;
      }

      if (r.repo.archived) {
        warnings.push(`${name} is archived (already read-only).`);
        continue;
      }
      const [teams, users, invites] = await Promise.all([gh.listRepoTeams(name), gh.listDirectCollaborators(name), gh.listRepoInvitations(name)]);
      const lower = (kind: SnapshotRow["kind"], p: Principal, label: string) =>
        changes.push({
          op: `lower_${kind}`,
          target: `${t}/${kind}:${p.id}`,
          summary: `Lower ${label} from ${p.permission} to read on ${name}`,
          params: { repo: name, kind, principal: p.id, permission: p.permission },
        });

      for (const team of teams) if (rank(team.permission) > rank("pull")) lower("team", team, `team ${untrusted(team.name, 60)}`);
      for (const user of users) {
        if (owners.has(user.id.toLowerCase())) continue;
        if (rank(user.permission) > rank("pull")) lower("user", user, `@${user.id}`);
      }
      for (const inv of invites) {
        if (inv.permission && rank(inv.permission) > rank("pull")) {
          lower("invitation", { id: String(inv.id), name: inv.login ?? "?", permission: inv.permission }, `pending invitation for @${untrusted(inv.login ?? "?", 40)}`);
        }
      }

      if (wantTag) {
        if (await gh.getRefSha(name, `tags/${tag}`)) warnings.push(`${name} already has tag ${tag}; kept as is.`);
        else if (!(await gh.getRefSha(name, `heads/${r.repo.default_branch}`))) warnings.push(`${name} has no commits on ${r.repo.default_branch}; no tag.`);
        else changes.push({ op: "create_tag", target: `${t}/tag`, summary: `Tag ${r.repo.default_branch} HEAD of ${name} as ${tag} (taken at apply time, after write access is gone)`, params: { repo: name, tag, branch: r.repo.default_branch } });
      }
      if (input.archive) changes.push({ op: "archive", target: t, summary: `Archive ${name} (read-only for everyone, apps included)`, params: { repo: name } });
    }

    if (!input.unfreeze) {
      const now = ctx.now?.() ?? new Date();
      const early = [...new Set(repos.map((r) => deadlineOf(ev.cfg, r.track)).filter((d): d is string => !!d && now < new Date(d)))];
      if (early.length) warnings.push(`Locking before the deadline (${early.join(", ")}). Teams lose write access now.`);
    }
    if (!input.unfreeze && owners.size) warnings.push(`Org owners (${owners.size}) keep admin on every repo and can still push. The submission tag marks what was there at the deadline.`);

    if (!input.unfreeze) {
      // Base permission applies to every member on every repo; a freeze cannot lower it.
      const base = (await gh.getOrg()).default_repository_permission;
      if (base === "write" || base === "admin") {
        warnings.push(`Org base permission is "${base}": every member can still push to every repo after this lock. Set it to "none" with org_settings_plan.`);
      } else if (base === "read") {
        warnings.push('Org base permission is "read": every member can read every team\'s repo. Set it to "none" with org_settings_plan.');
      }
      if (!input.archive) {
        try {
          const selfId = process.env.GITHUB_APP_ID;
          const writers = (await gh.listInstallations())
            .filter((i) => !(selfId && String(i.app_id) === selfId))
            .filter((i) => ["contents", "administration", "workflows"].some((k) => i.permissions[k] === "write" || i.permissions[k] === "admin"))
            .map((i) => `${i.app_slug} (${Object.entries(i.permissions).filter(([k, v]) => ["contents", "administration", "workflows"].includes(k) && v !== "read").map(([k, v]) => `${k}:${v}`).join(", ")})`);
          if (writers.length) {
            warnings.push(
              `Installed apps can still write after this lock: ${writers.join("; ")}. Only archiving (archive=true) stops them; ` +
                "or remove the team repos from those apps on GitHub. The submission tag and repos_activity show anything they push.",
            );
          }
        } catch {
          // listing installations needs org administration read; the lock itself does not
        }
      }
    }

    return {
      // Not grouped by repo: all permissions drop first (all teams at once), then the tags, then archiving.
      changes: sortChanges(changes),
      warnings,
      info: { scope: input.track ? `track ${input.track}` : input.team_nos?.length ? `teams ${input.team_nos.join(", ")}` : "whole event", repos: repos.map((r) => ({ repo: r.name, team_no: r.team_no, track: r.track, deadline: deadlineOf(ev.cfg, r.track) })) },
    };
  },

  async execute(ctx, change) {
    const gh = ctx.gh;
    const p = change.params as { repo: string; kind?: SnapshotRow["kind"]; principal?: string; permission?: string; tag?: string; branch?: string };
    const snap = () => ctx.db.saveSnapshot({ repo: p.repo, kind: p.kind!, principal: p.principal!, permission: p.permission! });
    const forget = () => ctx.db.deleteSnapshot(p.repo, p.kind!, p.principal!);
    switch (change.op) {
      case "lower_team":
        snap();
        return gh.setTeamRepoPermission(p.principal!, p.repo, "pull");
      case "lower_user":
        snap();
        return gh.setCollaborator(p.repo, p.principal!, "pull");
      case "lower_invitation":
        snap();
        return gh.updateRepoInvitation(p.repo, Number(p.principal), "read");
      case "restore_team":
        await gh.setTeamRepoPermission(p.principal!, p.repo, p.permission as RepoPermission);
        return forget();
      case "restore_user":
        await gh.setCollaborator(p.repo, p.principal!, p.permission as RepoPermission);
        return forget();
      case "restore_invitation":
        await gh.updateRepoInvitation(p.repo, Number(p.principal), INVITE_PERM[p.permission!] ?? "write");
        return forget();
      case "forget_snapshot":
        return forget();
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
