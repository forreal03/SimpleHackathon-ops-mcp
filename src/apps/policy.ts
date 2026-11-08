import type { AppPolicy } from "../config/schema.js";

export type Tier = "allow" | "review1" | "review2" | "reject";

export const TIER_ORDER: Record<Tier, number> = { allow: 0, review1: 1, review2: 2, reject: 3 };
export const TIER_LABEL: Record<Tier, string> = {
  allow: "recommend approve (read-only)",
  review1: "approve after 1 operator checks",
  review2: "2 operators must review",
  reject: "reject",
};

/** Organization-wide permissions. Anything prefixed organization_ also counts. */
const ORG_PERMS = new Set(["members", "team_discussions", "custom_properties_for_organizations"]);
/** Permissions on the authorising user's own account, not on the org. */
const ACCOUNT_PERMS = new Set([
  "emails",
  "profile",
  "followers",
  "gpg_keys",
  "git_ssh_keys",
  "ssh_signing_keys",
  "starring",
  "watching",
  "interaction_limits",
  "plan",
  "blocking",
  "codespaces_user_secrets",
  "copilot_messages",
  "copilot_editor_context",
  "knowledge_bases",
]);

export type Scope = "organization" | "repository" | "account";

export function scopeOf(permission: string): Scope {
  if (ORG_PERMS.has(permission) || permission.startsWith("organization_")) return "organization";
  if (ACCOUNT_PERMS.has(permission)) return "account";
  return "repository";
}

const isWrite = (level: string) => level === "write" || level === "admin";

function listed(list: string[], permission: string, level: string): boolean {
  return list.some((entry) => {
    const [name, lvl = "write"] = entry.split(":");
    if (name !== permission) return false;
    return lvl === "read" ? true : isWrite(level);
  });
}

export interface PermissionFinding {
  permission: string;
  level: string;
  scope: Scope;
  tier: Tier;
  why: string;
}

export interface AppSubject {
  slug: string;
  found: boolean;
  owner_type: string | null;
  permissions: Record<string, string>;
  /** Only known once the app is installed. */
  repository_selection?: "all" | "selected" | null;
}

export interface Evaluation {
  tier: Tier;
  tier_label: string;
  base_tier: Tier;
  allowlisted: boolean;
  findings: PermissionFinding[];
  other_reasons: string[];
}

const max = (a: Tier, b: Tier): Tier => (TIER_ORDER[a] >= TIER_ORDER[b] ? a : b);

/**
 * The tier is set by the single most dangerous thing the app asks for.
 * Allow-listed apps drop one tier, but never out of "reject" and never below "review1".
 */
export function evaluateApp(policy: AppPolicy, app: AppSubject): Evaluation {
  const findings: PermissionFinding[] = [];
  const other: string[] = [];
  let tier: Tier = "allow";

  for (const [permission, level] of Object.entries(app.permissions).sort(([a], [b]) => a.localeCompare(b))) {
    const scope = scopeOf(permission);
    let t: Tier = "allow";
    let why = "read only";
    if (scope === "account") {
      why = "applies to the installing user's own account, not the org";
    } else if (scope === "organization" && isWrite(level)) {
      t = "reject";
      why = "write access to the whole organization";
    } else if (listed(policy.deny_permissions.organization, permission, level) && scope === "organization") {
      t = "reject";
      why = "listed in deny_permissions.organization";
    } else if (scope === "repository" && listed(policy.deny_permissions.repository, permission, level)) {
      t = "reject";
      why = "listed in deny_permissions.repository";
    } else if (scope === "repository" && isWrite(level)) {
      if (listed(policy.review2_permissions.repository, permission, level)) {
        t = "review2";
        why = permission === "administration" ? "can change repo settings, collaborators and rulesets" : permission === "workflows" ? "can change CI workflows" : "listed in review2_permissions";
      } else {
        t = "review1";
        why = "write access limited to the selected repositories";
      }
    }
    tier = max(tier, t);
    findings.push({ permission, level, scope, tier: t, why });
  }

  if (!app.found) {
    tier = max(tier, "review2");
    other.push("App not found on GitHub; cannot check its owner or permissions.");
  } else if (app.owner_type !== "Organization") {
    tier = max(tier, "review2");
    other.push(app.owner_type ? `Owned by a personal account (${app.owner_type}).` : "Owner unknown.");
  }
  if (policy.deny.includes(app.slug)) {
    tier = "reject";
    other.push("Listed in deny.");
  }
  if (policy.require_selected_repos && app.repository_selection === "all") {
    tier = "reject";
    other.push('Installed on "All repositories"; only selected repositories are allowed.');
  }

  const base = tier;
  const allowlisted = policy.allow.includes(app.slug);
  if (allowlisted && policy.allow_lowers_tier > 0 && tier === "review2") {
    tier = "review1";
    other.push("Allow-listed: lowered from review2 to review1.");
  }

  return { tier, tier_label: TIER_LABEL[tier], base_tier: base, allowlisted, findings, other_reasons: other };
}

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Permissions in `now` that are new or higher than in `before`. */
export function expandedPermissions(before: Record<string, string>, now: Record<string, string>): string[] {
  return Object.entries(now)
    .filter(([k, v]) => (LEVEL[v] ?? 0) > (LEVEL[before[k] ?? ""] ?? 0))
    .map(([k, v]) => `${k}:${v}${before[k] ? ` (was ${before[k]})` : " (new)"}`);
}
