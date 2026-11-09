import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { eventDir, parseEventYaml, spreadsheetIdFrom } from "../config/load.js";
import { UserError } from "../lib/util.js";

/** Default names for the three roster tables, as files (local) or tabs (google_sheets). */
const LOCAL = { participants: "participants.csv", assignment: "assignment.csv", github_ids: "github_ids.csv" };
const SHEETS = { participants: "웹신청", assignment: "팀배정", github_ids: "GitHub아이디" };

const csvLine = (cells: string[]) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");

/**
 * Chooses where the roster lives: CSV files kept on this computer, or a Google Sheet (read-only).
 * Edits event.yaml (comments kept). Switching to local writes empty CSV files with the right headers.
 */
export function setRosterSource(eventId: string, source: "local" | "google_sheets", spreadsheet?: string) {
  const dir = eventDir(eventId);
  const file = path.join(dir, "event.yaml");
  if (!existsSync(file)) throw new UserError(`No config for event "${eventId}". Run event_init first.`);
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  const names = source === "local" ? LOCAL : SHEETS;
  const created: string[] = [];

  if (source === "google_sheets") {
    const link = spreadsheet ?? (doc.getIn(["roster", "spreadsheet"]) as string | undefined) ?? (doc.getIn(["roster", "spreadsheet_id"]) as string | undefined);
    if (!link || !spreadsheetIdFrom(String(link))) {
      throw new UserError("Give the Google Sheet's link (spreadsheet) to read the roster from Google Sheets.");
    }
    doc.setIn(["roster", "spreadsheet"], spreadsheet ?? link);
  } else {
    doc.deleteIn(["roster", "spreadsheet"]);
    doc.deleteIn(["roster", "spreadsheet_id"]);
  }
  doc.setIn(["roster", "source"], source);
  // Keep custom names; only swap names that are the other mode's defaults (or file names when going to sheets).
  for (const key of ["participants", "assignment", "github_ids"] as const) {
    const at = ["roster", `${key}_tab`];
    const now = doc.getIn(at) as string | undefined;
    const otherDefault = source === "local" ? SHEETS[key] : LOCAL[key];
    if (now === undefined || now === otherDefault || (source === "google_sheets" && String(now).endsWith(".csv"))) doc.setIn(at, names[key]);
  }

  const text = doc.toString();
  const cfg = parseEventYaml(text, file);
  writeFileSync(file, text);

  if (source === "local") {
    const c = cfg.roster.columns;
    const a = cfg.roster.assignment_columns;
    const g = cfg.roster.github_ids_columns;
    const templates: [string | undefined, (string | undefined)[]][] = [
      [cfg.roster.participants_tab, [c.email, c.name, c.github_login]],
      [cfg.roster.assignment_tab, [a.team_no, a.email, a.role, a.track, a.github_login]],
      [cfg.roster.github_ids_tab, [g.email, g.github_login]],
    ];
    for (const [name, headers] of templates) {
      if (!name) continue;
      const target = path.resolve(dir, name);
      if (!target.startsWith(dir + path.sep) || existsSync(target)) continue;
      writeFileSync(target, "﻿" + csvLine(headers.filter((h): h is string => !!h)) + "\n");
      created.push(target);
    }
  }

  return {
    source,
    files_or_tabs: { participants: cfg.roster.participants_tab, assignment: cfg.roster.assignment_tab, github_ids: cfg.roster.github_ids_tab ?? null },
    created,
    next:
      source === "local"
        ? `Fill the CSV files in ${dir} (UTF-8; Excel "CSV UTF-8" or a Google Sheets download both work), then run roster_sync. They stay on this computer and are never committed.`
        : "Give the server read access (service account shared as Viewer, or gcloud login), then run roster_sources and roster_sync.",
  };
}
