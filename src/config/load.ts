import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { AppPolicySchema, EventConfigSchema, type AppPolicy, type EventConfig } from "./schema.js";
import { UserError } from "../lib/util.js";

export const EVENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Folder that holds `events/` and `policies/`. Set HACKATHON_OPS_HOME when the client starts the server elsewhere. */
export function homeDir(): string {
  return path.resolve(process.env.HACKATHON_OPS_HOME ?? process.cwd());
}

export function eventDir(eventId: string): string {
  if (!EVENT_ID_RE.test(eventId)) throw new UserError(`Invalid event id "${eventId}".`);
  const dir = path.resolve(homeDir(), "events", eventId);
  // Defence in depth: the regex already rules out "..", but never leave events/.
  if (!dir.startsWith(path.resolve(homeDir(), "events") + path.sep)) throw new UserError("Invalid event path.");
  return dir;
}

export interface LoadedEvent {
  id: string;
  dir: string;
  cfg: EventConfig;
  policy: AppPolicy;
}

function formatZodError(file: string, issues: { path: PropertyKey[]; message: string }[]): string {
  return `${file} is invalid:\n` + issues.map((i) => `  - ${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("\n");
}

/**
 * Accepts https://docs.google.com/spreadsheets/d/<id>/edit..., https://drive.google.com/file/d/<id>/view,
 * https://drive.google.com/open?id=<id>, or the bare ID.
 */
export function spreadsheetIdFrom(value: string): string | null {
  const v = value.trim();
  const m = v.match(/\/(?:spreadsheets\/d|file\/d)\/([A-Za-z0-9_-]{20,})/) ?? v.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m?.[1]) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(v) ? v : null;
}

export function parseEventYaml(text: string, file = "event.yaml"): EventConfig {
  const parsed = EventConfigSchema.safeParse(YAML.parse(text));
  if (!parsed.success) throw new UserError(formatZodError(file, parsed.error.issues));
  const cfg = parsed.data;
  if (cfg.roster.source === "google_sheets") {
    const raw = cfg.roster.spreadsheet ?? cfg.roster.spreadsheet_id;
    if (!raw) throw new UserError(`${file}: roster.spreadsheet (the sheet's link) is required when roster.source is google_sheets.`);
    const id = spreadsheetIdFrom(raw);
    if (!id) throw new UserError(`${file}: roster.spreadsheet "${raw}" is not a Google Sheets link or ID.`);
    cfg.roster.spreadsheet_id = id;
  }
  if (cfg.teams.size[0] > cfg.teams.size[1]) throw new UserError(`${file}: teams.size must be [min, max].`);
  return cfg;
}

export function parsePolicyYaml(text: string, file = "app-policy.yaml"): AppPolicy {
  const parsed = AppPolicySchema.safeParse(YAML.parse(text) ?? {});
  if (!parsed.success) throw new UserError(formatZodError(file, parsed.error.issues));
  return parsed.data;
}

export function loadEvent(eventId: string): LoadedEvent {
  const dir = eventDir(eventId);
  const file = path.join(dir, "event.yaml");
  if (!existsSync(file)) {
    throw new UserError(`No config for event "${eventId}" (looked for ${file}). Run event_init first.`);
  }
  const cfg = parseEventYaml(readFileSync(file, "utf8"), file);
  if (cfg.event_id !== eventId) {
    throw new UserError(`${file}: event_id is "${cfg.event_id}" but the folder is "${eventId}".`);
  }
  const policyFile = path.resolve(dir, cfg.app_policy);
  const policy = existsSync(policyFile)
    ? parsePolicyYaml(readFileSync(policyFile, "utf8"), policyFile)
    : AppPolicySchema.parse({});
  return { id: eventId, dir, cfg, policy };
}
