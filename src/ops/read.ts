import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { homeDir, eventDir, loadEvent } from "../config/load.js";
import { packageRoot } from "../paths.js";
import { display, loadRoster, summarizeRoster } from "../roster/roster.js";
import { describeSources, tableReader } from "../roster/sources.js";
import { patternToRegExp, untrusted, UserError } from "../lib/util.js";
import { errorMessage } from "../github/api.js";
import type { Ctx } from "../plans/engine.js";
import { mapLimit } from "../plans/common.js";
import { deadlineOf, discoverRepos } from "../repos/discover.js";
import { submissionTag } from "../plans/freeze.js";

// ---------------------------------------------------------------- event_init

export function eventInit(args: { event_id: string; org: string; overwrite?: boolean }) {
  const dir = eventDir(args.event_id);
  const file = path.join(dir, "event.yaml");
  const created: string[] = [];

  const validate = () => {
    try {
      loadEvent(args.event_id);
      return { valid: true as const };
    } catch (err) {
      if (err instanceof UserError) return { valid: false as const, to_fix: err.message };
      throw err;
    }
  };

  if (existsSync(file) && !args.overwrite) {
    return { status: "exists", file, ...validate(), next: "Edit event.yaml, then run org_check and roster_sources." };
  }

  const doc = YAML.parseDocument(readFileSync(path.join(packageRoot(), "events", "example", "event.yaml"), "utf8"));
  doc.setIn(["event_id"], args.event_id);
  doc.setIn(["github", "org"], args.org);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, doc.toString());
  created.push(file);

  const policy = path.join(homeDir(), "policies", "app-policy.yaml");
  if (!existsSync(policy)) {
    mkdirSync(path.dirname(policy), { recursive: true });
    writeFileSync(policy, readFileSync(path.join(packageRoot(), "policies", "app-policy.yaml"), "utf8"));
    created.push(policy);
  }

  return {
    status: "created",
    created,
    ...validate(),
    next: "Put the sheet's link in roster.spreadsheet, then the tab names, column mapping and track templates. Run roster_sources to check the sheet, then org_check.",
  };
}

// ---------------------------------------------------------------- org_check

const REQUIRED_APP_PERMS: Record<string, string> = {
  members: "write",
  organization_administration: "read",
  administration: "write",
  contents: "write",
  metadata: "read",
};
const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

export async function orgCheck(ctx: Ctx) {
  const org = ctx.ev.cfg.github.org;
  const checks: { check: string; ok: boolean | null; value?: unknown; hint?: string }[] = [];
  const add = (check: string, ok: boolean | null, value?: unknown, hint?: string) => checks.push({ check, ok, value, ...(ok === true ? {} : { hint }) });

  add("auth_mode", ctx.gh.authMode === "app", ctx.gh.authMode, "GITHUB_TOKEN is for trying things out. Use the GitHub App for a real event.");

  const info = await ctx.gh.getOrg();
  add("default_repository_permission", info.default_repository_permission === "none", info.default_repository_permission, `Set Base permissions to "No permission" so teams cannot read each other's repos: https://github.com/organizations/${org}/settings/member_privileges`);
  add("members_can_create_repositories", info.members_can_create_repositories === false, info.members_can_create_repositories, "Turn off repository creation for members so all repos are created by this server.");
  add(
    "members_can_fork_private_repositories",
    info.members_can_fork_private_repositories === false,
    info.members_can_fork_private_repositories,
    "Turn off forking of private repos, or anyone with read access (mentors, judges) can keep a copy of a team's code.",
  );
  let without2fa: number | null = null;
  try {
    without2fa = (await ctx.gh.listMembersWithout2fa()).length;
  } catch {
    // owner-only on GitHub; leave unknown
  }
  add(
    "two_factor_requirement_enabled",
    info.two_factor_requirement_enabled ?? null,
    { required: info.two_factor_requirement_enabled, members_without_2fa: without2fa },
    `Off or not visible. Turning it on REMOVES every member without 2FA from the org${without2fa ? ` (${without2fa} now)` : ""}. ` +
      `Decide before inviting participants. org_settings_plan with require_two_factor shows exactly who: https://github.com/organizations/${org}/settings/security`,
  );

  const perms = await ctx.gh.ownInstallationPermissions();
  if (perms) {
    const missing = Object.entries(REQUIRED_APP_PERMS).filter(([k, lvl]) => (LEVEL[perms[k] ?? ""] ?? 0) < (LEVEL[lvl] ?? 0));
    add("app_permissions", missing.length === 0, perms, `The GitHub App needs: ${missing.map(([k, v]) => `${k}:${v}`).join(", ")}. Update the App's permissions, then accept the change on the org.`);
  }

  try {
    const read = ctx.read ?? tableReader(ctx.ev);
    const t = await read(ctx.ev.cfg.roster.participants_tab);
    add("roster_access", true, `${ctx.ev.cfg.roster.participants_tab}: ${t.rows.length} rows`);
  } catch (err) {
    add("roster_access", false, null, errorMessage(err));
  }

  for (const [track, t] of Object.entries(ctx.ev.cfg.tracks)) {
    if (!t.template) continue;
    const tpl = await ctx.gh.getTemplate(t.template);
    add(`template:${track}`, !!tpl?.is_template, t.template, tpl ? "Mark it as a template repository in its settings." : "Template repo not found or not visible to the app.");
  }

  const manual = [
    `OAuth app access restrictions should be on (default for new orgs): https://github.com/organizations/${org}/settings/oauth_application_policy`,
    `GitHub App installation requests arrive by email to owners; feed them to app_requests_ingest.`,
  ];
  return { org, ok: checks.every((c) => c.ok !== false), checks, manual };
}

// ---------------------------------------------------------------- roster

export async function rosterSources(ctx: Ctx) {
  const r = ctx.ev.cfg.roster;
  const c = r.columns;
  const a = r.assignment_columns;
  const g = r.github_ids_columns;
  const wanted = [
    { role: "participants", tab: r.participants_tab, columns: [c.email, c.name, c.google_sub, c.github_login] },
    { role: "assignment", tab: r.assignment_tab, columns: [a.team_no, a.email, a.role, a.track, a.github_login] },
    ...(r.github_ids_tab ? [{ role: "github_ids", tab: r.github_ids_tab, columns: [g.email, g.github_login] }] : []),
  ].map((w) => ({ ...w, columns: w.columns.filter((x): x is string => !!x) }));

  const out = await describeSources(ctx.ev, wanted);
  const missingTabs = out.configured.filter((t) => !t.exists).map((t) => `${t.role}: "${t.tab}"`);
  const badColumns = out.configured.filter((t) => t.missing_columns?.length).map((t) => `${t.tab}: ${t.missing_columns!.join(", ")}`);
  return {
    ...out,
    spreadsheet_url: r.source === "google_sheets" ? `https://docs.google.com/spreadsheets/d/${r.spreadsheet_id}/edit` : null,
    ready: missingTabs.length === 0 && badColumns.length === 0,
    to_fix: [
      ...missingTabs.map((t) => `Tab missing (${t}). Create it or change the tab name in event.yaml.`),
      ...badColumns.map((t) => `Columns not found in ${t}. Rename them in the sheet or fix the mapping in event.yaml.`),
    ],
  };
}

export async function rosterSync(ctx: Ctx) {
  const roster = await loadRoster(ctx.ev, ctx.read);
  ctx.db.audit({ actor: ctx.actor, tool: "roster_sync", plan_id: null, target: null, result: "ok", detail: { teams: roster.teams.length, people: roster.people.length, problems: roster.problems.map((p) => p.kind) } });
  return { event: ctx.ev.id, ...summarizeRoster(roster) };
}

export async function githubHandlesCheck(ctx: Ctx) {
  const roster = await loadRoster(ctx.ev, ctx.read);
  const people = roster.people.filter((p) => p.github_login);
  const results = await mapLimit(people, 5, async (p) => {
    const user = await ctx.gh.getUser(p.github_login!);
    if (!user) return { name: display(p), team_no: p.team_no, github_login: p.github_login, status: "not_found" as const };
    if (user.type !== "User") return { name: display(p), team_no: p.team_no, github_login: p.github_login, status: "not_a_user" as const, type: user.type };
    return { name: display(p), team_no: p.team_no, github_login: user.login, status: "ok" as const };
  });
  const bad = results.filter((r) => r.status !== "ok");
  return {
    checked: results.length,
    missing_login: roster.people.length - people.length,
    ok: results.length - bad.length,
    problems: bad,
    hint: bad.length ? "Ask these people for their exact username (github.com/<username>) and fix the sheet." : undefined,
  };
}

// ---------------------------------------------------------------- teams_list

export async function teamsList(ctx: Ctx, args: { team_no?: string }) {
  const re = patternToRegExp(ctx.ev.cfg.github.team_name);
  const teams = (await ctx.gh.listTeams()).filter((t) => re.test(t.name));
  const invites = await ctx.gh.listOrgInvitations();
  const picked = args.team_no ? teams.filter((t) => t.name.toLowerCase().includes(args.team_no!.toLowerCase())) : teams;
  const out = await mapLimit(picked, 5, async (t) => ({ team: untrusted(t.name, 60), slug: t.slug, members: await ctx.gh.listTeamMembers(t.slug) }));
  return {
    teams: out.sort((a, b) => a.team.localeCompare(b.team, "en", { numeric: true })),
    pending_org_invitations: invites.filter((i) => i.login).map((i) => i.login),
    pending_email_invitations: invites.filter((i) => !i.login).length,
  };
}

// ---------------------------------------------------------------- repos_activity

const PUSH_TYPES = new Set(["push", "force_push", "pr_merge", "merge_queue_merge"]);

export async function reposActivity(ctx: Ctx, args: { track?: string; team_nos?: string[] }) {
  const cfg = ctx.ev.cfg;
  const repos = await discoverRepos(ctx, args);
  const start = cfg.schedule.start_at ? new Date(cfg.schedule.start_at) : null;
  const prepOn = cfg.schedule.prep_enabled;
  const prepFrom = prepOn && cfg.schedule.prep_from ? new Date(cfg.schedule.prep_from) : null;
  const tag = submissionTag(ctx);

  const out = await mapLimit(repos, 3, async (r) => {
    const name = r.name;
    const deadlineIso = deadlineOf(cfg, r.track);
    const deadline = deadlineIso ? new Date(deadlineIso) : null;
    const [commits, activity, tagSha] = await Promise.all([
      ctx.gh.listCommits(name, r.repo.default_branch, 1000),
      ctx.gh.listRepoActivity(name, 1000).catch(() => null),
      ctx.gh.getRefSha(name, `tags/${tag}`),
    ]);

    // Commit dates are chosen by whoever commits; the root commit is the template/initial commit.
    const work = commits.filter((c) => c.parents > 0);
    const at = (d: string) => new Date(d);
    const beforeStart = start ? work.filter((c) => at(c.date) < start) : [];
    // With a preparation period, commits inside it are fine; only those before it are "early".
    const inPrep = prepOn ? beforeStart.filter((c) => !prepFrom || at(c.date) >= prepFrom) : [];
    const early = start ? beforeStart.length - inPrep.length : null;
    const during = start ? work.filter((c) => at(c.date) >= start && (!deadline || at(c.date) <= deadline)).length : null;
    const datedAfter = deadline ? work.filter((c) => at(c.date) > deadline).length : null;

    // Push times come from GitHub's servers and cannot be faked.
    const pushes = (activity ?? []).filter((a) => PUSH_TYPES.has(a.type));
    const late = deadline ? pushes.filter((a) => at(a.timestamp) > deadline) : [];
    const forced = (activity ?? []).filter((a) => a.type === "force_push");
    const onTopOfTag = tagSha ? commits.findIndex((c) => c.sha === tagSha) : -1;

    const byAuthor = new Map<string, number>();
    for (const c of work) {
      const key = c.author_login ?? "(commits without a linked GitHub account)";
      byAuthor.set(key, (byAuthor.get(key) ?? 0) + 1);
    }

    const flags: string[] = [];
    if (early) {
      flags.push(
        prepOn && prepFrom
          ? `${early} commit(s) dated before the preparation period (${cfg.schedule.prep_from}): check for work made in advance (e.g. a capstone project)`
          : `${early} commit(s) dated before the start: check for work made in advance (e.g. a capstone project)`,
      );
    }
    if (late.length) flags.push(`${late.length} push(es) after the ${r.track ?? "event"} deadline (server time)`);
    if (forced.length) flags.push(`${forced.length} force push(es): history was rewritten`);
    if (onTopOfTag > 0) flags.push(`${onTopOfTag} commit(s) on the default branch after the submission tag`);
    if (work.length && byAuthor.size === 1) flags.push("all commits come from one person");

    return {
      team_no: r.team_no,
      repo: name,
      track: r.track,
      deadline: deadlineIso,
      commits: work.length,
      truncated: commits.length >= 1000,
      by_commit_date: { early, preparation: prepOn ? inPrep.length : null, during_event: during, after_deadline: datedAfter },
      server_pushes: activity
        ? {
            total: pushes.length,
            last_push_at: pushes[0]?.timestamp ?? null,
            after_deadline: late.slice(0, 10).map((a) => ({ at: a.timestamp, by: a.actor, type: a.type, branch: untrusted(a.ref.replace("refs/heads/", ""), 80) })),
            force_pushes: forced.length,
          }
        : "unavailable",
      contributors: [...byAuthor.entries()].sort((a, b) => b[1] - a[1]).map(([login, n]) => ({ login, commits: n })),
      submission_tag: tagSha ? tagSha.slice(0, 7) : null,
      flags,
    };
  });

  return {
    start_at: cfg.schedule.start_at ?? null,
    preparation: prepOn ? { enabled: true, from: cfg.schedule.prep_from ?? null } : { enabled: false },
    deadlines: Object.fromEntries([["event", deadlineOf(cfg, null)], ...Object.keys(cfg.tracks).map((k) => [k, deadlineOf(cfg, k)])]),
    repos: out,
    flagged: out.filter((r) => r.flags.length).map((r) => `${r.repo}: ${r.flags.join("; ")}`),
    note: "Commit dates can be faked; server push times cannot. A deadline of null means deadline checks are off for that track (schedule_set). Flags point judges at something to look at, they are not a verdict.",
  };
}
