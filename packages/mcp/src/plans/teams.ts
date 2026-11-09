import { display } from "../roster/roster.js";
import { maskEmail, normTeamNo, UserError } from "../lib/util.js";
import type { Change, PlanKind } from "./engine.js";
import { lenientRoster, rememberTeam, resolveTeam, sortChanges, strictRoster } from "./common.js";

/** Desired: one GitHub Team per roster team, every member with a GitHub login in it (invited if not in the org yet). */
export const teamsPlan: PlanKind<Record<string, never>> = {
  kind: "teams",
  codePrefix: "TEAMS",

  async compute(ctx) {
    const { gh, ev } = ctx;
    const roster = await strictRoster(ctx);
    const [teams, members, invites] = await Promise.all([gh.listTeams(), gh.listOrgMembers(), gh.listOrgInvitations()]);
    const teamByName = new Map(teams.map((t) => [t.name.toLowerCase(), t]));
    const orgMembers = new Set(members.map((m) => m.toLowerCase()));
    const invitedLogins = new Set(invites.flatMap((i) => (i.login ? [i.login.toLowerCase()] : [])));
    const invitedEmails = new Set(invites.flatMap((i) => (i.email ? [i.email.toLowerCase()] : [])));

    const current = new Map<string, Set<string>>();
    const maintainers = new Map<string, Set<string>>();
    for (const t of roster.teams) {
      const gt = teamByName.get(t.team_name.toLowerCase());
      current.set(t.team_name.toLowerCase(), new Set(gt ? (await gh.listTeamMembers(gt.slug)).map((l) => l.toLowerCase()) : []));
      maintainers.set(t.team_name.toLowerCase(), new Set(gt ? (await gh.listTeamMembers(gt.slug, "maintainer")).map((l) => l.toLowerCase()) : []));
    }
    const leaderRole = ev.cfg.github.leader_team_role;
    const roleFor = (p: { role: string }) => (p.role === "leader" && leaderRole === "maintainer" ? "maintainer" : "member");

    const changes: Change[] = [];
    const warnings: string[] = [];
    const rosterLogins = new Set<string>();

    for (const team of roster.teams) {
      const name = team.team_name;
      if (!teamByName.has(name.toLowerCase())) {
        changes.push({
          op: "create_team",
          target: `team:${name}`,
          summary: `Create secret team ${name}${team.track ? ` (${team.track})` : ""}`,
          params: { name, description: `${ev.id}${team.track ? ` · ${team.track}` : ""}` },
        });
      }

      for (const person of team.members) {
        const who = display(person);
        if (!person.github_login) {
          if (ev.cfg.github.invite_by_email && !invitedEmails.has(person.email)) {
            changes.push({
              op: "invite_email",
              target: `team:${name}/email:${maskEmail(person.email)}`,
              summary: `Invite ${who} to the org by email, into ${name}`,
              params: { email: person.email, team_name: name },
            });
          } else {
            warnings.push(`${who} (team ${team.team_no}) has no GitHub username and was skipped.`);
          }
          continue;
        }
        const login = person.github_login;
        const l = login.toLowerCase();
        rosterLogins.add(l);

        if (orgMembers.has(l)) {
          const role = roleFor(person);
          const isMaintainer = maintainers.get(name.toLowerCase())?.has(l) ?? false;
          if (!current.get(name.toLowerCase())?.has(l)) {
            changes.push({
              op: "add_membership",
              target: `team:${name}/user:${login}`,
              summary: `Add ${who} (@${login}) to ${name}${role === "maintainer" ? " as maintainer (leader)" : ""}`,
              params: { team_name: name, login, role },
            });
          } else if ((role === "maintainer") !== isMaintainer) {
            changes.push({
              op: "set_team_role",
              target: `team:${name}/user:${login}`,
              summary: role === "maintainer" ? `Make leader ${who} (@${login}) a maintainer of ${name}` : `Make ${who} (@${login}) a regular member of ${name} (not the leader)`,
              params: { team_name: name, login, role },
            });
          }
          for (const other of roster.teams) {
            if (other.team_name === name) continue;
            if (current.get(other.team_name.toLowerCase())?.has(l)) {
              changes.push({
                op: "remove_membership",
                target: `team:${other.team_name}/user:${login}`,
                summary: `Remove ${who} (@${login}) from ${other.team_name} (moved to ${name})`,
                params: { team_name: other.team_name, login },
              });
            }
          }
        } else if (invitedLogins.has(l)) {
          warnings.push(
            `${who} (@${login}) already has a pending org invitation. They join ${name} once they accept, if the invitation included it; otherwise run teams_plan again after they accept.` +
              (roleFor(person) === "maintainer" ? " As the leader they become maintainer on the next teams_plan after accepting (invitations cannot carry a team role)." : ""),
          );
        } else {
          changes.push({ op: "invite", target: `team:${name}/user:${login}`, summary: `Invite ${who} (@${login}) to the org, into ${name}`, params: { team_name: name, login } });
          if (roleFor(person) === "maintainer") warnings.push(`Leader ${who} (@${login}) is invited as a member; run teams_plan again after they accept to make them maintainer.`);
        }
      }
    }

    for (const team of roster.teams) {
      const extra = [...(current.get(team.team_name.toLowerCase()) ?? [])].filter((l) => !rosterLogins.has(l));
      if (extra.length) warnings.push(`${team.team_name} has members not in the roster (left as they are): ${extra.map((l) => "@" + l).join(", ")}.`);
    }

    return { changes: sortChanges(changes), warnings };
  },

  async execute(ctx, change, scratch) {
    const p = change.params as { name?: string; description?: string; team_name?: string; login?: string; email?: string; role?: "member" | "maintainer" };
    switch (change.op) {
      case "create_team": {
        rememberTeam(scratch, await ctx.gh.createTeam(p.name!, p.description ?? ""));
        return;
      }
      case "add_membership":
      case "set_team_role":
        return ctx.gh.addTeamMember((await resolveTeam(ctx, scratch, p.team_name!)).slug, p.login!, p.role ?? "member");
      case "remove_membership":
        return ctx.gh.removeTeamMember((await resolveTeam(ctx, scratch, p.team_name!)).slug, p.login!);
      case "invite": {
        const user = await ctx.gh.getUser(p.login!);
        if (!user) throw new UserError(`GitHub user @${p.login} does not exist.`);
        const team = await resolveTeam(ctx, scratch, p.team_name!);
        return ctx.gh.inviteToOrg({ invitee_id: user.id }, [team.id]);
      }
      case "invite_email": {
        const team = await resolveTeam(ctx, scratch, p.team_name!);
        return ctx.gh.inviteToOrg({ email: p.email! }, [team.id]);
      }
      default:
        throw new Error(`unknown op ${change.op}`);
    }
  },
};

/** Moves one person between managed teams. The assignment tab should be updated too. */
export const moveMemberPlan: PlanKind<{ login: string; to_team: string }> = {
  kind: "team_move",
  codePrefix: "MOVE",

  async compute(ctx, input) {
    const roster = await lenientRoster(ctx);
    const wanted = input.to_team.trim().toLowerCase();
    const to =
      roster.teams.find((t) => t.team_name.toLowerCase() === wanted) ??
      roster.teams.find((t) => t.team_no === normTeamNo(input.to_team, ctx.ev.cfg.github.team_no_pad));
    if (!to) throw new UserError(`No team "${input.to_team}" in the roster.`);
    const login = input.login.replace(/^@/, "");
    const l = login.toLowerCase();
    if (!(await ctx.gh.listOrgMembers()).some((m) => m.toLowerCase() === l)) {
      throw new UserError(`@${login} is not an org member yet. Use teams_plan to invite them.`);
    }

    const teams = new Map((await ctx.gh.listTeams()).map((t) => [t.name.toLowerCase(), t]));
    if (!teams.has(to.team_name.toLowerCase())) throw new UserError(`GitHub team ${to.team_name} does not exist yet. Run teams_apply first.`);

    const changes: Change[] = [];
    for (const t of roster.teams) {
      const gt = teams.get(t.team_name.toLowerCase());
      if (!gt) continue;
      const isIn = (await ctx.gh.listTeamMembers(gt.slug)).some((m) => m.toLowerCase() === l);
      if (t.team_name === to.team_name && !isIn) {
        changes.push({ op: "add_membership", target: `team:${t.team_name}/user:${login}`, summary: `Add @${login} to ${t.team_name}`, params: { team_name: t.team_name, login } });
      }
      if (t.team_name !== to.team_name && isIn) {
        changes.push({ op: "remove_membership", target: `team:${t.team_name}/user:${login}`, summary: `Remove @${login} from ${t.team_name}`, params: { team_name: t.team_name, login } });
      }
    }

    const inSheet = roster.people.find((p) => p.github_login?.toLowerCase() === l);
    const warnings = [
      inSheet?.team_no === to.team_no
        ? "The assignment tab already has this person on the target team."
        : "Update the assignment tab too; otherwise the next teams_plan moves this person back.",
    ];
    return { changes: sortChanges(changes), warnings };
  },

  execute: (ctx, change, scratch) => teamsPlan.execute(ctx, change, scratch),
};
