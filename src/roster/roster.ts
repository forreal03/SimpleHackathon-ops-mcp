import type { EventConfig } from "../config/schema.js";
import type { LoadedEvent } from "../config/load.js";
import { fill, maskEmail, normEmail, normLogin, normTeamNo } from "../lib/util.js";
import { requireColumns, tableReader, type Table, type TableReader } from "./sources.js";

export type Role = "leader" | "member";

export interface Person {
  email: string;
  name: string;
  github_login: string | null;
  team_no: string | null;
  role: Role;
}

export interface Team {
  team_no: string;
  team_name: string;
  repo_name: string;
  track: string | null;
  track_id: string;
  template: string | null;
  leader: Person | null;
  members: Person[];
}

export interface Problem {
  kind: string;
  severity: "error" | "warning";
  message: string;
  team_no?: string;
  people?: string[];
}

export interface Roster {
  people: Person[];
  teams: Team[];
  problems: Problem[];
}

export interface Reviewer {
  name: string;
  github_login: string;
  role: "mentor" | "judge";
  /** Team numbers, or "all" for judges with no assignment. */
  teams: string[] | "all";
}

/** Who a person is in tool output: never the raw email. */
export const display = (p: Pick<Person, "name" | "email">) => p.name || maskEmail(p.email);

export function resolveTrack(cfg: EventConfig, raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  for (const [key, t] of Object.entries(cfg.tracks)) {
    if (key.toLowerCase() === v || t.id.toLowerCase() === v || t.aliases.some((a) => a.trim().toLowerCase() === v)) {
      return key;
    }
  }
  return null;
}

const isLeader = (raw: string) => /leader|lead|조장|팀장|리더/i.test(raw);

export function teamNames(cfg: EventConfig, teamNo: string, track: string | null) {
  const trackId = track ? cfg.tracks[track]?.id ?? "" : "";
  const vars = { team_no: teamNo, track_id: trackId, track: track ?? "", event_id: cfg.event_id };
  const team_name = fill(cfg.github.team_name, vars);
  const repo_name = fill(cfg.repo.name_pattern, { ...vars, team_name }).replace(/[^A-Za-z0-9._-]/g, "-");
  return { team_name, repo_name, track_id: trackId };
}

export interface RosterTables {
  participants: Table;
  assignment: Table;
  githubIds?: Table;
}

/** Pure: joins the tables and reports every problem it can see. */
export function buildRoster(cfg: EventConfig, t: RosterTables): Roster {
  const col = cfg.roster.columns;
  const acol = cfg.roster.assignment_columns;
  const problems: Problem[] = [];

  requireColumns(t.participants, [col.email, col.name, col.google_sub, col.github_login]);
  requireColumns(t.assignment, [acol.team_no, acol.email, acol.role, acol.track, acol.github_login]);

  // 1. Participants, keyed by email.
  const byEmail = new Map<string, Person>();
  for (const row of t.participants.rows) {
    const email = normEmail(row[col.email]);
    if (!email) continue;
    byEmail.set(email, {
      email,
      name: col.name ? row[col.name] ?? "" : "",
      github_login: null,
      team_no: null,
      role: "member",
    });
  }

  // 2. GitHub logins: participants column < assignment column < separate GitHub-ID form (latest wins).
  const loginSource = new Map<string, string>();
  const invalid: string[] = [];
  const setLogin = (email: string, raw: string, source: string) => {
    const p = byEmail.get(email);
    if (!p || !raw.trim()) return;
    const login = normLogin(raw);
    if (login === null) {
      invalid.push(display(p));
      return;
    }
    if (p.github_login && login && p.github_login.toLowerCase() !== login.toLowerCase()) {
      problems.push({
        kind: "github_login_conflict",
        severity: "warning",
        message: `${display(p)}: ${loginSource.get(email)} says "${p.github_login}", ${source} says "${login}". Using ${source}.`,
        people: [display(p)],
      });
    }
    if (login) {
      p.github_login = login;
      loginSource.set(email, source);
    }
  };
  if (col.github_login) for (const row of t.participants.rows) setLogin(normEmail(row[col.email]), row[col.github_login] ?? "", "participants tab");

  // 3. Assignment rows.
  const pad = cfg.github.team_no_pad;
  const teamRows = new Map<string, { people: Person[]; tracks: Set<string>; rawTracks: Set<string> }>();
  const notInParticipants: string[] = [];
  const seen = new Map<string, string>();
  const duplicates: string[] = [];

  for (const row of t.assignment.rows) {
    const email = normEmail(row[acol.email]);
    const teamNo = normTeamNo(row[acol.team_no], pad);
    if (!email && !teamNo) continue;
    if (!email || !teamNo) {
      problems.push({ kind: "incomplete_assignment_row", severity: "error", message: "An assignment row is missing team number or email." });
      continue;
    }
    const person = byEmail.get(email);
    if (!person) {
      notInParticipants.push(maskEmail(email));
      continue;
    }
    if (seen.has(email) && seen.get(email) !== teamNo) {
      duplicates.push(`${display(person)} (${seen.get(email)}, ${teamNo})`);
      continue;
    }
    seen.set(email, teamNo);
    person.team_no = teamNo;
    person.role = acol.role && isLeader(row[acol.role] ?? "") ? "leader" : "member";
    if (acol.github_login) setLogin(email, row[acol.github_login] ?? "", "assignment tab");

    const entry = teamRows.get(teamNo) ?? { people: [], tracks: new Set<string>(), rawTracks: new Set<string>() };
    if (!entry.people.includes(person)) entry.people.push(person);
    const rawTrack = acol.track ? (row[acol.track] ?? "").trim() : "";
    if (rawTrack) {
      entry.rawTracks.add(rawTrack);
      const resolved = resolveTrack(cfg, rawTrack);
      if (resolved) entry.tracks.add(resolved);
    }
    teamRows.set(teamNo, entry);
  }

  if (t.githubIds) {
    const gcol = cfg.roster.github_ids_columns;
    requireColumns(t.githubIds, [gcol.email, gcol.github_login]);
    for (const row of t.githubIds.rows) setLogin(normEmail(row[gcol.email]), row[gcol.github_login] ?? "", "GitHub ID form");
  }

  if (notInParticipants.length) {
    problems.push({
      kind: "not_in_participants_tab",
      severity: "error",
      message: `${notInParticipants.length} assigned email(s) are not in the participants tab.`,
      people: notInParticipants,
    });
  }
  if (duplicates.length) {
    problems.push({ kind: "duplicate_assignment", severity: "error", message: "Assigned to more than one team.", people: duplicates });
  }
  if (invalid.length) {
    problems.push({ kind: "invalid_github_login", severity: "error", message: "Not a valid GitHub username.", people: invalid });
  }

  // 4. Teams.
  const tracksConfigured = Object.keys(cfg.tracks).length > 0;
  const [minSize, maxSize] = cfg.teams.size;
  const teams: Team[] = [];
  for (const [teamNo, entry] of [...teamRows.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
    let track: string | null = null;
    if (entry.tracks.size > 1) {
      problems.push({ kind: "track_conflict", severity: "error", team_no: teamNo, message: `Team ${teamNo} has more than one track: ${[...entry.tracks].join(", ")}.` });
    } else if (entry.tracks.size === 1) {
      track = [...entry.tracks][0] ?? null;
    } else if (entry.rawTracks.size > 0) {
      problems.push({ kind: "unknown_track", severity: "error", team_no: teamNo, message: `Team ${teamNo}: unknown track "${[...entry.rawTracks].join(", ")}". Add it to tracks or its aliases.` });
    } else if (tracksConfigured) {
      problems.push({ kind: "missing_track", severity: "error", team_no: teamNo, message: `Team ${teamNo} has no track.` });
    }

    const leaders = entry.people.filter((p) => p.role === "leader");
    if (leaders.length !== 1) {
      problems.push({
        kind: "leader_count",
        severity: "warning",
        team_no: teamNo,
        message: `Team ${teamNo} has ${leaders.length} leaders (expected 1).`,
      });
    }
    if (entry.people.length < minSize || entry.people.length > maxSize) {
      problems.push({
        kind: "team_size",
        severity: "error",
        team_no: teamNo,
        message: `Team ${teamNo} has ${entry.people.length} members (allowed ${minSize}-${maxSize}).`,
      });
    }

    const names = teamNames(cfg, teamNo, track);
    teams.push({
      team_no: teamNo,
      ...names,
      track,
      template: track ? cfg.tracks[track]?.template ?? null : null,
      leader: leaders.length === 1 ? leaders[0]! : null,
      members: entry.people,
    });
  }

  const dupNames = teams.filter((tm, i) => teams.findIndex((o) => o.team_name.toLowerCase() === tm.team_name.toLowerCase()) !== i);
  if (dupNames.length) {
    problems.push({ kind: "duplicate_team_name", severity: "error", message: `team_name pattern gives duplicate names: ${dupNames.map((d) => d.team_name).join(", ")}.` });
  }

  // 5. People-level checks.
  const people = [...byEmail.values()];
  const unassigned = people.filter((p) => !p.team_no);
  if (unassigned.length) {
    problems.push({ kind: "unassigned", severity: "warning", message: `${unassigned.length} participant(s) are not on any team.`, people: unassigned.map(display) });
  }
  const assigned = people.filter((p) => p.team_no);
  const noLogin = assigned.filter((p) => !p.github_login);
  if (noLogin.length) {
    problems.push({
      kind: "missing_github_login",
      severity: "warning",
      message: `${noLogin.length} assigned participant(s) have no GitHub username. They are skipped by teams_plan.`,
      people: noLogin.map(display),
    });
  }
  const byLogin = new Map<string, Person[]>();
  for (const p of assigned) if (p.github_login) byLogin.set(p.github_login.toLowerCase(), [...(byLogin.get(p.github_login.toLowerCase()) ?? []), p]);
  const shared = [...byLogin.entries()].filter(([, ps]) => ps.length > 1);
  if (shared.length) {
    problems.push({
      kind: "duplicate_github_login",
      severity: "error",
      message: "The same GitHub username is used by more than one person.",
      people: shared.map(([login, ps]) => `${login}: ${ps.map(display).join(", ")}`),
    });
  }

  return { people: assigned, teams, problems };
}

export function buildReviewers(cfg: EventConfig, table: Table, teams: Team[]): { reviewers: Reviewer[]; problems: Problem[] } {
  if (!cfg.reviewers) return { reviewers: [], problems: [] };
  const c = cfg.reviewers.columns;
  requireColumns(table, [c.name, c.github_login, c.role, c.teams]);
  const known = new Set(teams.map((t) => t.team_no));
  const reviewers: Reviewer[] = [];
  const problems: Problem[] = [];

  for (const row of table.rows) {
    const name = row[c.name] ?? "";
    const rawLogin = row[c.github_login] ?? "";
    if (!name && !rawLogin) continue;
    const login = normLogin(rawLogin);
    if (!login) {
      problems.push({ kind: "reviewer_login", severity: "error", message: `Reviewer ${name || "(no name)"} has no valid GitHub username.` });
      continue;
    }
    const roleRaw = row[c.role] ?? "";
    const role = /mentor|멘토/i.test(roleRaw) ? "mentor" : /judge|심사/i.test(roleRaw) ? "judge" : null;
    if (!role) {
      problems.push({ kind: "reviewer_role", severity: "error", message: `Reviewer ${name}: role must be mentor/멘토 or judge/심사위원.` });
      continue;
    }
    const teamNos = (row[c.teams] ?? "")
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map((x) => normTeamNo(x, cfg.github.team_no_pad));
    const unknown = teamNos.filter((n) => !known.has(n));
    if (unknown.length) {
      problems.push({ kind: "reviewer_unknown_team", severity: "error", message: `Reviewer ${name}: unknown team(s) ${unknown.join(", ")}.` });
      continue;
    }
    if (role === "mentor" && teamNos.length === 0) {
      problems.push({ kind: "mentor_without_team", severity: "error", message: `Mentor ${name} has no assigned team. Mentors only see their own teams.` });
      continue;
    }
    reviewers.push({ name, github_login: login, role, teams: teamNos.length ? teamNos : "all" });
  }
  return { reviewers, problems };
}

/** Reads the configured tabs and builds the roster. */
export async function loadRoster(ev: LoadedEvent, read: TableReader = tableReader(ev)): Promise<Roster> {
  const r = ev.cfg.roster;
  const [participants, assignment, githubIds] = await Promise.all([
    read(r.participants_tab),
    read(r.assignment_tab),
    r.github_ids_tab ? read(r.github_ids_tab) : Promise.resolve(undefined),
  ]);
  return buildRoster(ev.cfg, { participants, assignment, githubIds });
}

export async function loadReviewers(ev: LoadedEvent, roster: Roster, read: TableReader = tableReader(ev)) {
  if (!ev.cfg.reviewers) return { reviewers: [], problems: [{ kind: "no_reviewers_config", severity: "error" as const, message: "event.yaml has no reviewers section." }] };
  return buildReviewers(ev.cfg, await read(ev.cfg.reviewers.tab), roster.teams);
}

export function summarizeRoster(roster: Roster) {
  const errors = roster.problems.filter((p) => p.severity === "error");
  return {
    teams: roster.teams.length,
    participants: roster.people.length,
    with_github_login: roster.people.filter((p) => p.github_login).length,
    problems: roster.problems,
    ready_for_teams_plan: errors.length === 0,
    team_list: roster.teams.map((t) => ({
      team_no: t.team_no,
      team_name: t.team_name,
      repo: t.repo_name,
      track: t.track,
      size: t.members.length,
      leader: t.leader ? display(t.leader) : null,
      members: t.members.map((m) => ({ name: display(m), github_login: m.github_login })),
    })),
  };
}
