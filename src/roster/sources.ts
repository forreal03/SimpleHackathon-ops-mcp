import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";
import type { LoadedEvent } from "../config/load.js";
import { parseCsv } from "./csv.js";
import { UserError } from "../lib/util.js";

export interface Table {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
}

export type TableReader = (name: string) => Promise<Table>;

function toTable(name: string, values: string[][]): Table {
  const [head = [], ...body] = values;
  const headers = head.map((h) => String(h ?? "").trim());
  const rows = body.map((cells) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) rec[h] = String(cells[i] ?? "").trim();
    });
    return rec;
  });
  return { name, headers, rows };
}

let sheetsAuth: GoogleAuth | null = null;

function googleAuth(): GoogleAuth {
  if (sheetsAuth) return sheetsAuth;
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  sheetsAuth = inline ? new GoogleAuth({ scopes, credentials: JSON.parse(inline) }) : new GoogleAuth({ scopes });
  return sheetsAuth;
}

/** Read-only access to the event's roster tables. Never writes to the sheet. */
export function tableReader(ev: LoadedEvent): TableReader {
  const roster = ev.cfg.roster;

  if (roster.source === "csv") {
    return async (name) => {
      const file = path.resolve(ev.dir, name);
      if (!file.startsWith(ev.dir + path.sep)) throw new UserError(`CSV path must stay inside the event folder: ${name}`);
      if (!existsSync(file)) throw new UserError(`CSV not found: ${file}`);
      return toTable(name, parseCsv(readFileSync(file, "utf8")));
    };
  }

  const id = roster.spreadsheet_id!;
  return async (tab) => {
    const client = await googleAuth().getClient();
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}` +
      `/values/${encodeURIComponent(`'${tab.replace(/'/g, "''")}'`)}?majorDimension=ROWS`;
    try {
      const res = await client.request<{ values?: string[][] }>({ url });
      return toTable(tab, res.data.values ?? []);
    } catch (err) {
      const status = (err as { status?: number; response?: { status?: number } }).response?.status;
      if (status === 403 || status === 404) {
        throw new UserError(
          `Cannot read tab "${tab}" (HTTP ${status}). Share the spreadsheet with the service account as Viewer and check the tab name.`,
        );
      }
      throw err;
    }
  };
}

/** Throws a helpful error when a configured column is not in the table. */
export function requireColumns(table: Table, columns: (string | undefined)[]): void {
  const missing = columns.filter((c): c is string => !!c && !table.headers.includes(c));
  if (missing.length) {
    throw new UserError(
      `Tab "${table.name}" has no column ${missing.map((m) => `"${m}"`).join(", ")}. ` +
        `Columns found: ${table.headers.filter(Boolean).map((h) => `"${h}"`).join(", ")}. Fix the column mapping in event.yaml.`,
    );
  }
}
