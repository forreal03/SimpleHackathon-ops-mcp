import { readFileSync, existsSync, readdirSync } from "node:fs";
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

/** The tab (or CSV file) does not exist. Optional tabs are skipped; required ones become a roster problem. */
export class TabMissingError extends UserError {
  constructor(readonly tab: string, detail: string) {
    super(detail);
    this.name = "TabMissingError";
  }
}

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

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
let sheetsAuth: GoogleAuth | null = null;

/** Service account (GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_SERVICE_ACCOUNT_JSON) or the operator's own gcloud login (ADC). */
function googleAuth(): GoogleAuth {
  if (sheetsAuth) return sheetsAuth;
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  sheetsAuth = inline ? new GoogleAuth({ scopes: SCOPES, credentials: JSON.parse(inline) }) : new GoogleAuth({ scopes: SCOPES });
  return sheetsAuth;
}

/** The email the spreadsheet must be shared with, when a service account is used. */
export function serviceAccountEmail(): string | null {
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? (process.env.GOOGLE_APPLICATION_CREDENTIALS ? readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8") : null);
    if (!raw) return null;
    const json = JSON.parse(raw) as { type?: string; client_email?: string };
    return json.type === "service_account" ? json.client_email ?? null : null;
  } catch {
    return null;
  }
}

function sheetsError(err: unknown, what: string, tab?: string): Error {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
  const status = e.response?.status;
  const message = e.response?.data?.error?.message ?? e.message ?? String(err);
  if (status === 400 && tab && /Unable to parse range/i.test(message)) {
    return new TabMissingError(tab, `The spreadsheet has no tab named "${tab}".`);
  }
  if (status === 403 || status === 404) {
    const sa = serviceAccountEmail();
    return new UserError(
      `Cannot read ${what} (HTTP ${status}). ` +
        (sa ? `Share the spreadsheet with ${sa} as Viewer.` : "Check that your Google login can open the spreadsheet.") +
        " Also check that the Google Sheets API is enabled for the credentials' project.",
    );
  }
  if (/default credentials|Could not load the default credentials/i.test(message)) {
    return new UserError(
      "No Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service account key, or run " +
        "`gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets.readonly`.",
    );
  }
  return err instanceof Error ? err : new Error(message);
}

async function sheetsGet<T>(url: string, what: string, tab?: string): Promise<T> {
  try {
    const client = await googleAuth().getClient();
    const res = await client.request<T>({ url });
    return res.data;
  } catch (err) {
    throw sheetsError(err, what, tab);
  }
}

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const rangeOf = (tab: string, cells = "") => encodeURIComponent(`'${tab.replace(/'/g, "''")}'${cells}`);

/** Read-only access to the event's roster tables. Never writes to the sheet. */
export function tableReader(ev: LoadedEvent): TableReader {
  const roster = ev.cfg.roster;

  if (roster.source === "csv") {
    return async (name) => {
      const file = path.resolve(ev.dir, name);
      if (!file.startsWith(ev.dir + path.sep)) throw new UserError(`CSV path must stay inside the event folder: ${name}`);
      if (!existsSync(file)) throw new TabMissingError(name, `CSV not found: ${file}`);
      return toTable(name, parseCsv(readFileSync(file, "utf8")));
    };
  }

  const id = roster.spreadsheet_id!;
  return async (tab) => {
    const data = await sheetsGet<{ values?: string[][] }>(`${SHEETS}/${encodeURIComponent(id)}/values/${rangeOf(tab)}?majorDimension=ROWS`, `tab "${tab}"`, tab);
    return toTable(tab, data.values ?? []);
  };
}

export interface TabReport {
  role: string;
  tab: string;
  exists: boolean;
  rows?: number;
  headers?: string[];
  missing_columns?: string[];
}

/** What is in the designated spreadsheet (or CSV folder) and how it matches event.yaml. */
export async function describeSources(ev: LoadedEvent, wanted: { role: string; tab: string; columns: string[] }[]) {
  const roster = ev.cfg.roster;
  let title: string | null = null;
  let tabs: string[];

  if (roster.source === "csv") {
    tabs = existsSync(ev.dir) ? readdirSync(ev.dir).filter((f) => f.toLowerCase().endsWith(".csv")) : [];
  } else {
    const meta = await sheetsGet<{ properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] }>(
      `${SHEETS}/${encodeURIComponent(roster.spreadsheet_id!)}?fields=properties.title,sheets.properties.title`,
      "the spreadsheet",
    );
    title = meta.properties?.title ?? null;
    tabs = (meta.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  }

  const read = tableReader(ev);
  const reports: TabReport[] = [];
  for (const w of wanted) {
    if (!tabs.includes(w.tab)) {
      reports.push({ role: w.role, tab: w.tab, exists: false });
      continue;
    }
    const t = await read(w.tab);
    reports.push({
      role: w.role,
      tab: w.tab,
      exists: true,
      rows: t.rows.length,
      headers: t.headers.filter(Boolean),
      missing_columns: w.columns.filter((c) => !t.headers.includes(c)),
    });
  }
  return { source: roster.source, spreadsheet_title: title, all_tabs: tabs, configured: reports, share_with: serviceAccountEmail() };
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
