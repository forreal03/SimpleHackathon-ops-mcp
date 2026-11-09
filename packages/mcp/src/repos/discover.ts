import type { EventConfig } from "../config/schema.js";
import type { RepoInfo } from "../github/api.js";
import type { Ctx } from "../plans/engine.js";
import { normTeamNo, UserError } from "../lib/util.js";

/** A team repo found on GitHub by its name, no roster needed. */
export interface EventRepo {
  name: string;
  team_no: string;
  track: string | null;
  repo: RepoInfo;
}

export interface RepoFilter {
  track?: string;
  team_nos?: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function nameRegex(cfg: EventConfig, pattern: string, forRepo: boolean): RegExp {
  const body = pattern
    .split(/(\{\w+\})/)
    .map((part) => {
      if (part === "{team_no}") return "(?<team_no>\\d+)";
      if (part === "{track_id}") return "(?<track_id>[A-Za-z0-9]+)";
      if (part === "{event_id}") return escape(cfg.event_id);
      if (/^\{\w+\}$/.test(part)) return "[A-Za-z0-9._ -]+";
      // Repo names cannot hold spaces etc.; GitHub turns them into "-".
      return escape(forRepo ? part.replace(/[^A-Za-z0-9._-]/g, "-") : part);
    })
    .join("");
  return new RegExp(`^${body}$`, "i");
}

/** Regex for repo names made from repo.name_pattern, capturing team_no (and track_id when used). */
export function repoNameRegex(cfg: EventConfig): RegExp {
  return nameRegex(cfg, cfg.repo.name_pattern.replace("{team_name}", cfg.github.team_name), true);
}

/** Regex for GitHub Team names made from github.team_name, capturing team_no. */
export function teamNameRegex(cfg: EventConfig): RegExp {
  return nameRegex(cfg, cfg.github.team_name, false);
}

/**
 * Which event team(s) each org member is on, from the GitHub Teams themselves (login lowercased -> team numbers).
 * Used to keep participants from being given access to other teams' repos.
 */
export async function participantTeams(ctx: Ctx): Promise<Map<string, string[]>> {
  const re = teamNameRegex(ctx.ev.cfg);
  const out = new Map<string, string[]>();
  for (const team of await ctx.gh.listTeams()) {
    const no = team.name.match(re)?.groups?.team_no;
    if (!no) continue;
    const teamNo = normTeamNo(no, ctx.ev.cfg.github.team_no_pad);
    for (const login of await ctx.gh.listTeamMembers(team.slug)) {
      const l = login.toLowerCase();
      out.set(l, [...(out.get(l) ?? []), teamNo]);
    }
  }
  return out;
}

function inRange(teamNo: string, spec: string): boolean {
  const n = Number(teamNo);
  const [a, b] = spec.split("-").map((x) => Number(x.trim()));
  return b === undefined ? n === a : n >= a! && n <= b;
}

/** Track of a team number from tracks.<key>.teams ranges. */
export function trackOfTeam(cfg: EventConfig, teamNo: string): string | null {
  for (const [key, t] of Object.entries(cfg.tracks)) {
    if (t.teams.some((spec) => inRange(teamNo, spec))) return key;
  }
  return null;
}

/** Whether deadline checks are on for a track (track setting, else schedule.freeze_enabled). */
export function deadlineEnabled(cfg: EventConfig, track: string | null): boolean {
  return (track ? cfg.tracks[track]?.freeze_enabled : undefined) ?? cfg.schedule.freeze_enabled;
}

/** Deadline that applies to a track (track freeze_at, else schedule.freeze_at); null when checks are off. */
export function deadlineOf(cfg: EventConfig, track: string | null): string | null {
  if (!deadlineEnabled(cfg, track)) return null;
  return (track ? cfg.tracks[track]?.freeze_at : undefined) ?? cfg.schedule.freeze_at ?? null;
}

export function checkTrack(cfg: EventConfig, track?: string) {
  if (track && !Object.hasOwn(cfg.tracks, track)) throw new UserError(`Unknown track "${track}". Tracks in event.yaml: ${Object.keys(cfg.tracks).join(", ") || "(none)"}.`);
}

export async function discoverRepos(ctx: Ctx, filter: RepoFilter = {}): Promise<EventRepo[]> {
  const cfg = ctx.ev.cfg;
  checkTrack(cfg, filter.track);
  const re = repoNameRegex(cfg);
  const pad = cfg.github.team_no_pad;
  const byId = new Map(Object.entries(cfg.tracks).map(([k, t]) => [t.id.toLowerCase(), k]));

  const found: EventRepo[] = [];
  for (const repo of await ctx.gh.listOrgRepos()) {
    const m = repo.name.match(re);
    if (!m?.groups?.team_no) continue;
    const teamNo = normTeamNo(m.groups.team_no, pad);
    const track = (m.groups.track_id ? byId.get(m.groups.track_id.toLowerCase()) : undefined) ?? trackOfTeam(cfg, teamNo);
    found.push({ name: repo.name, team_no: teamNo, track, repo });
  }

  let picked = found;
  if (filter.track) {
    picked = picked.filter((r) => r.track === filter.track);
    if (picked.length === 0) {
      throw new UserError(`No repos in track "${filter.track}". Set tracks.${filter.track}.teams (e.g. ["01-10"]) or use {track_id} in the repo name.`);
    }
  }
  if (filter.team_nos?.length) {
    const wanted = new Set(filter.team_nos.map((n) => normTeamNo(n, pad)));
    picked = picked.filter((r) => wanted.has(r.team_no));
    const missing = [...wanted].filter((n) => !picked.some((r) => r.team_no === n));
    if (missing.length) throw new UserError(`No repo for team(s) ${missing.join(", ")} (repo names follow "${cfg.repo.name_pattern}").`);
  }
  return picked.sort((a, b) => a.team_no.localeCompare(b.team_no, "en", { numeric: true }));
}
