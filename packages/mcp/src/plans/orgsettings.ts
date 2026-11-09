import type { OrgSettingsPatch } from "../github/api.js";
import { errorMessage } from "../github/api.js";
import type { Change, Ctx, PlanKind } from "./engine.js";

export interface OrgSettingsInput extends OrgSettingsPatch {
  /** GitHub has no API for this switch; the plan reports who it would remove and links the setting. */
  require_two_factor?: boolean;
}

const SETTABLE = ["members_can_create_repositories", "default_repository_permission", "members_can_fork_private_repositories"] as const;

async function twoFactorReport(ctx: Ctx, wanted: boolean, current: boolean | null | undefined) {
  const org = ctx.ev.cfg.github.org;
  const url = `https://github.com/organizations/${org}/settings/security`;
  let members: string[] | null = null;
  let outside: string[] | null = null;
  let error: string | undefined;
  try {
    [members, outside] = await Promise.all([ctx.gh.listMembersWithout2fa(), ctx.gh.listOutsideCollaboratorsWithout2fa()]);
  } catch (err) {
    error = `Could not list people without 2FA (owner-only on GitHub): ${errorMessage(err)}`;
  }
  const affected = members && outside ? members.length + outside.length : null;
  let effect: string;
  if (current === wanted) effect = `Already ${wanted ? "required" : "not required"}. Nothing to do.`;
  else if (!wanted) effect = "Turning it off removes nobody. Members keep their access.";
  else if (affected === 0) effect = "Everyone already has 2FA. Turning it on removes nobody.";
  else if (affected) effect = `Turning it on REMOVES these ${affected} people from the org right away. They must enable 2FA and be invited again.`;
  else effect = "Turning it on removes everyone without 2FA from the org. The list could not be read.";

  return {
    currently_required: current ?? null,
    wanted,
    members_without_2fa: members,
    outside_collaborators_without_2fa: outside,
    effect,
    how: `GitHub has no API for this switch. A person flips it at ${url} ("Require two-factor authentication").`,
    ...(error ? { error } : {}),
  };
}

/** Toggle the org settings GitHub allows through the API, and report on 2FA enforcement. */
export const orgSettingsPlan: PlanKind<OrgSettingsInput> = {
  kind: "org_settings",
  codePrefix: "ORG",

  async compute(ctx, input) {
    const org = await ctx.gh.getOrg();
    const changes: Change[] = [];
    for (const field of SETTABLE) {
      const want = input[field];
      if (want === undefined) continue;
      const now = org[field];
      if (now === want) continue;
      changes.push({
        op: "set_org_setting",
        target: `org:${field}`,
        summary: `${field}: ${String(now)} -> ${String(want)}`,
        params: { field, value: want },
      });
    }

    const warnings: string[] = [];
    if (input.members_can_create_repositories === true) warnings.push("Members will be able to create repos outside this server's control.");
    if (input.default_repository_permission && input.default_repository_permission !== "none") {
      warnings.push(`Every org member will get ${input.default_repository_permission} on every repo, so teams can see each other's work.`);
    }

    const info =
      input.require_two_factor === undefined ? undefined : { two_factor: await twoFactorReport(ctx, input.require_two_factor, org.two_factor_requirement_enabled) };
    return { changes, warnings, info };
  },

  async execute(ctx, change) {
    const { field, value } = change.params as { field: keyof OrgSettingsPatch; value: never };
    await ctx.gh.updateOrg({ [field]: value });
  },
};
