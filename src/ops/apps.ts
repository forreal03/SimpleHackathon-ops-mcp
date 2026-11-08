import type { Installation } from "../github/api.js";
import { evaluateApp, expandedPermissions, TIER_ORDER, type Tier } from "../apps/policy.js";
import { parseInstallRequestEmail, verifyInstallRequest, type RawEmail } from "../apps/mail.js";
import { loadRoster, display, type Roster } from "../roster/roster.js";
import { UserError } from "../lib/util.js";
import type { Ctx } from "../plans/engine.js";

const settingsUrl = (ctx: Ctx) => `https://github.com/organizations/${ctx.ev.cfg.github.org}/settings/installations`;

/** This server's own GitHub App needs every repo, so it is exempt from the app policy. */
const isSelf = (i: Installation) => !!process.env.GITHUB_APP_ID && String(i.app_id) === process.env.GITHUB_APP_ID;

async function tryRoster(ctx: Ctx): Promise<Roster | null> {
  try {
    return await loadRoster(ctx.ev, ctx.read);
  } catch {
    return null;
  }
}

function requesterInfo(roster: Roster | null, login: string | null) {
  if (!login) return { requester: null, in_roster: null, team: null };
  if (!roster) return { requester: login, in_roster: null, team: null };
  const person = roster.people.find((p) => p.github_login?.toLowerCase() === login.toLowerCase());
  const team = person ? roster.teams.find((t) => t.team_no === person.team_no) : undefined;
  return { requester: login, in_roster: !!person, name: person ? display(person) : null, team: team ? { team_no: team.team_no, repo: team.repo_name } : null };
}

export async function reviewApp(ctx: Ctx, args: { app_slug?: string; installation_id?: number }, installations?: Installation[]) {
  if (!args.app_slug && !args.installation_id) throw new UserError("Give app_slug or installation_id.");
  const list = installations ?? (await ctx.gh.listInstallations());
  const inst = args.installation_id ? list.find((i) => i.id === args.installation_id) : list.find((i) => i.app_slug === args.app_slug);
  if (args.installation_id && !inst) throw new UserError(`No installation ${args.installation_id} on ${ctx.ev.cfg.github.org}.`);
  const slug = (inst?.app_slug ?? args.app_slug)!;
  const app = await ctx.gh.getApp(slug);

  const permissions = inst?.permissions ?? app?.permissions ?? {};
  const evaluation = evaluateApp(ctx.ev.policy, {
    slug,
    found: !!app,
    owner_type: app?.owner_type ?? null,
    permissions,
    repository_selection: inst?.repository_selection ?? null,
  });
  const requests = ctx.db.requests(slug);

  return {
    app: app ? { slug: app.slug, name: app.name, owner: app.owner_login, owner_type: app.owner_type, url: app.html_url } : { slug, name: null, found: false },
    installed: inst ? { installation_id: inst.id, repository_selection: inst.repository_selection, suspended: !!inst.suspended_at } : null,
    permissions_source: inst ? "installation (granted)" : "app defaults (what it will ask for)",
    ...evaluation,
    decision: ctx.db.decision(slug),
    pending_requests: requests.length,
  };
}

export async function listApps(ctx: Ctx) {
  const installations = await ctx.gh.listInstallations();
  return Promise.all(
    installations.map(async (i) => {
      if (isSelf(i)) return { installation_id: i.id, app_slug: i.app_slug, self: true, note: "this server (hackathon-ops); exempt from the app policy" };
      const r = await reviewApp(ctx, { installation_id: i.id }, installations);
      return {
        installation_id: i.id,
        app_slug: i.app_slug,
        repository_selection: i.repository_selection,
        suspended: !!i.suspended_at,
        tier: r.tier,
        decision: r.decision?.verdict ?? "none",
        permissions: i.permissions,
      };
    }),
  );
}

const REQUIRED_APPROVERS: Record<Tier, number> = { allow: 1, review1: 1, review2: 2, reject: 0 };

export async function decideApp(ctx: Ctx, args: { app_slug: string; verdict: "approve" | "reject"; reason: string; approvers: string[] }) {
  const review = await reviewApp(ctx, { app_slug: args.app_slug });
  const approvers = [...new Set(args.approvers.map((a) => a.trim()).filter(Boolean))];

  if (args.verdict === "approve") {
    if (review.tier === "reject") throw new UserError(`Policy rejects ${args.app_slug}: ${[...review.findings.filter((f) => f.tier === "reject").map((f) => `${f.permission}:${f.level}`), ...review.other_reasons].join("; ")}. Change the policy file if this is really wanted.`);
    const need = REQUIRED_APPROVERS[review.tier];
    if (approvers.length < need) throw new UserError(`${args.app_slug} is "${review.tier}": approving needs ${need} named approver(s) in approvers.`);
  }

  ctx.db.saveDecision({
    app_slug: args.app_slug,
    installation_id: review.installed?.installation_id ?? null,
    permissions: Object.fromEntries(review.findings.map((f) => [f.permission, f.level])),
    repository_selection: review.installed?.repository_selection ?? null,
    tier: review.tier,
    verdict: args.verdict,
    reason: args.reason,
    approvers,
    decided_by: ctx.actor,
    decided_at: new Date().toISOString(),
  });
  ctx.db.audit({ actor: ctx.actor, tool: "app_decide", plan_id: null, target: `app:${args.app_slug}`, result: args.verdict, detail: { tier: review.tier, approvers, reason: args.reason } });

  const roster = await tryRoster(ctx);
  const requests = ctx.db.requests(args.app_slug);
  const latest = requests[0];
  const teams = [...new Map(requests.map((r) => requesterInfo(roster, r.requester)).filter((r) => r.team).map((r) => [r.team!.repo, r.team!])).values()];

  return {
    app_slug: args.app_slug,
    verdict: args.verdict,
    tier: review.tier,
    open_on_github: latest?.review_url ?? settingsUrl(ctx),
    checklist:
      args.verdict === "approve"
        ? [
            'Choose "Only select repositories", never "All repositories".',
            teams.length ? `Select only: ${teams.map((t) => t.repo).join(", ")}.` : "Select only the requesting team's repo.",
            "Check the permission list on that page matches this review.",
            "Run apps_drift afterwards.",
          ]
        : ["Open the link and choose Deny (or just ignore the request).", "Tell the team why and suggest an alternative."],
  };
}

export async function appsDrift(ctx: Ctx) {
  const installations = (await ctx.gh.listInstallations()).filter((i) => !isSelf(i));
  const decisions = new Map(ctx.db.decisions().map((d) => [d.app_slug, d]));
  const issues: { app_slug: string; installation_id: number; issue: string; detail?: string[] }[] = [];

  for (const inst of installations) {
    const d = decisions.get(inst.app_slug);
    if (!d) {
      issues.push({ app_slug: inst.app_slug, installation_id: inst.id, issue: "installed without a recorded decision" });
      continue;
    }
    if (d.verdict === "reject") issues.push({ app_slug: inst.app_slug, installation_id: inst.id, issue: "installed although the decision was reject" });
    if (inst.repository_selection === "all") issues.push({ app_slug: inst.app_slug, installation_id: inst.id, issue: 'installed on "All repositories"' });
    const grown = expandedPermissions(d.permissions, inst.permissions);
    if (grown.length) issues.push({ app_slug: inst.app_slug, installation_id: inst.id, issue: "permissions grew since the decision", detail: grown });
    const now = await reviewApp(ctx, { installation_id: inst.id }, installations);
    if (TIER_ORDER[now.tier] > TIER_ORDER[d.tier as Tier]) {
      issues.push({ app_slug: inst.app_slug, installation_id: inst.id, issue: `tier went from ${d.tier} to ${now.tier}` });
    }
  }
  return { installations: installations.length, ok: issues.length === 0, issues, settings: settingsUrl(ctx) };
}

export async function ingestRequests(ctx: Ctx, emails: RawEmail[]) {
  const org = await ctx.gh.getOrg();
  const roster = await tryRoster(ctx);
  const rejected: { subject: string; reasons: string[] }[] = [];
  const accepted = [];

  for (const email of emails) {
    const parsed = parseInstallRequestEmail(email);
    if (!parsed.ok) {
      rejected.push({ subject: parsed.subject, reasons: parsed.reasons });
      continue;
    }
    const reasons = verifyInstallRequest(parsed.request, org);
    if (reasons.length) {
      rejected.push({ subject: email.subject, reasons });
      continue;
    }
    accepted.push(parsed.request);
    ctx.db.upsertRequest({
      request_id: parsed.request.request_id,
      app_slug: parsed.request.app_slug,
      app_name: parsed.request.app_name,
      requester: parsed.request.requester,
      review_url: parsed.request.review_url,
      received_at: parsed.request.received_at,
    });
  }

  const installations = await ctx.gh.listInstallations();
  const slugs = [...new Set(accepted.map((r) => r.app_slug))].sort();
  const apps = [];
  for (const slug of slugs) {
    const reqs = accepted.filter((r) => r.app_slug === slug).sort((a, b) => b.received_at.localeCompare(a.received_at));
    const byRequester = new Map<string, number>();
    for (const r of reqs) byRequester.set(r.requester, (byRequester.get(r.requester) ?? 0) + 1);
    const review = await reviewApp(ctx, { app_slug: slug }, installations);
    apps.push({
      app_slug: slug,
      app_name: reqs[0]!.app_name,
      emails: reqs.length,
      requesters: [...byRequester.entries()]
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .map(([login, count]) => ({ ...requesterInfo(roster, login), emails: count })),
      review_url: reqs[0]!.review_url,
      tier: review.tier,
      tier_label: review.tier_label,
      allowlisted: review.allowlisted,
      findings: review.findings.filter((f) => f.tier !== "allow"),
      other_reasons: review.other_reasons,
      already_installed: !!review.installed,
      decision: review.decision?.verdict ?? null,
    });
  }

  ctx.db.audit({ actor: ctx.actor, tool: "app_requests_ingest", plan_id: null, target: null, result: "ok", detail: { emails: emails.length, accepted: accepted.length, rejected: rejected.length, apps: slugs } });
  return {
    emails: emails.length,
    accepted: accepted.length,
    rejected,
    apps,
    note: roster ? undefined : "Roster could not be read, so requesters were not matched to teams.",
    next: "Decide each app with app_decide, then open review_url to approve or deny on GitHub.",
  };
}
