import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { eventDir, parseEventYaml, type LoadedEvent } from "../config/load.js";
import type { EventConfig } from "../config/schema.js";
import { deadlineEnabled, deadlineOf } from "../repos/discover.js";
import { UserError } from "../lib/util.js";

/** "+09:00" for a time zone at a given instant. */
function offsetFor(at: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName");
  const m = part?.value.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

/**
 * Accepts ISO with an offset ("2026-11-14T10:00:00+09:00", "...Z") or a local time in the event's time zone
 * ("2026-11-14 10:00", "2026-11-14"), and returns ISO with an offset.
 */
export function toEventTime(value: string, timeZone: string): string {
  const v = value.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    if (Number.isNaN(new Date(v).getTime())) throw new UserError(`"${value}" is not a valid date/time.`);
    return v;
  }
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new UserError(`"${value}" is not a date/time. Use e.g. "2026-11-14 10:00" (event time zone) or "2026-11-14T10:00:00+09:00".`);
  const local = `${m[1]}-${m[2]}-${m[3]}T${(m[4] ?? "00").padStart(2, "0")}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  const out = `${local}${offsetFor(new Date(`${local}Z`), timeZone)}`;
  if (Number.isNaN(new Date(out).getTime())) throw new UserError(`"${value}" is not a valid date/time.`);
  return out;
}

export function describeSchedule(cfg: EventConfig) {
  const s = cfg.schedule;
  return {
    timezone: cfg.timezone,
    start_at: s.start_at ?? null,
    preparation: s.prep_enabled
      ? { enabled: true, from: s.prep_from ?? null, meaning: s.prep_from ? `commits from ${s.prep_from} until the start are allowed` : "every commit before the start is allowed" }
      : { enabled: false, meaning: "commits before the start are flagged" },
    deadline: { enabled: s.freeze_enabled, at: s.freeze_at ?? null },
    tracks: Object.fromEntries(
      Object.entries(cfg.tracks).map(([k, t]) => [
        k,
        { teams: t.teams, deadline_enabled: deadlineEnabled(cfg, k), deadline: deadlineOf(cfg, k), own_setting: t.freeze_at !== undefined || t.freeze_enabled !== undefined },
      ]),
    ),
  };
}

export interface ScheduleChange {
  start_at?: string | null;
  prep_enabled?: boolean;
  prep_from?: string | null;
  freeze_enabled?: boolean;
  freeze_at?: string | null;
  /** When given, freeze_enabled / freeze_at apply to this track only. */
  track?: string;
}

/** Edits the schedule in event.yaml (comments kept), validates the result, then saves. */
export function setSchedule(ev: LoadedEvent, change: ScheduleChange) {
  const file = path.join(eventDir(ev.id), "event.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  const tz = ev.cfg.timezone;
  const changed: string[] = [];

  const put = (keys: string[], value: unknown) => {
    if (value === undefined) return;
    if (value === null) doc.deleteIn(keys);
    else doc.setIn(keys, value);
    changed.push(`${keys.join(".")} = ${value === null ? "(removed)" : String(value)}`);
  };
  const time = (v: string | null | undefined) => (v === undefined || v === null ? v : toEventTime(v, tz));

  if (change.track) {
    if (!Object.hasOwn(ev.cfg.tracks, change.track)) throw new UserError(`Unknown track "${change.track}". Tracks: ${Object.keys(ev.cfg.tracks).join(", ") || "(none)"}.`);
    if (change.start_at !== undefined || change.prep_enabled !== undefined || change.prep_from !== undefined) {
      throw new UserError("start_at and the preparation period are event-wide; call without track for them.");
    }
    put(["tracks", change.track, "freeze_enabled"], change.freeze_enabled);
    put(["tracks", change.track, "freeze_at"], time(change.freeze_at));
  } else {
    put(["schedule", "start_at"], time(change.start_at));
    put(["schedule", "prep_enabled"], change.prep_enabled);
    put(["schedule", "prep_from"], time(change.prep_from));
    put(["schedule", "freeze_enabled"], change.freeze_enabled);
    put(["schedule", "freeze_at"], time(change.freeze_at));
  }

  if (changed.length === 0) return { changed: [], schedule: describeSchedule(ev.cfg) };

  const text = doc.toString();
  const cfg = parseEventYaml(text, file);
  const s = cfg.schedule;
  if (s.prep_from && s.start_at && new Date(s.prep_from) >= new Date(s.start_at)) throw new UserError("prep_from must be before start_at.");
  for (const k of [null, ...Object.keys(cfg.tracks)]) {
    const d = deadlineOf(cfg, k);
    if (d && s.start_at && new Date(d) <= new Date(s.start_at)) throw new UserError(`The ${k ? `${k} ` : ""}deadline (${d}) must be after start_at (${s.start_at}).`);
  }
  writeFileSync(file, text);
  return { changed, schedule: describeSchedule(cfg) };
}
