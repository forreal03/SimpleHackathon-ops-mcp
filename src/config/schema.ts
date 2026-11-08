import { z } from "zod";

const Permission = z.enum(["pull", "triage", "push", "maintain", "admin"]);

export const EventConfigSchema = z.object({
  event_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "lowercase letters, digits and '-' only"),
  timezone: z.string().default("UTC"),
  write_delay_ms: z.number().int().min(0).default(1000),

  github: z.object({
    org: z.string().min(1),
    /** GitHub Team name. Placeholders: {team_no} {track_id} {track} {event_id} */
    team_name: z.string().default("Team{team_no}"),
    team_no_pad: z.number().int().min(1).max(6).default(2),
    /** Invite people without a GitHub login by email. Weak identity check, so off by default. */
    invite_by_email: z.boolean().default(false),
  }),

  roster: z.object({
    source: z.enum(["google_sheets", "csv"]),
    /** Required for google_sheets. */
    spreadsheet_id: z.string().optional(),
    /** Tab names for google_sheets, file paths (relative to the event folder) for csv. */
    participants_tab: z.string(),
    assignment_tab: z.string(),
    github_ids_tab: z.string().optional(),
    columns: z.object({
      email: z.string(),
      name: z.string().optional(),
      google_sub: z.string().optional(),
      github_login: z.string().optional(),
    }),
    assignment_columns: z.object({
      team_no: z.string(),
      email: z.string(),
      role: z.string().optional(),
      track: z.string().optional(),
      github_login: z.string().optional(),
    }),
    github_ids_columns: z
      .object({ email: z.string(), github_login: z.string() })
      .default({ email: "이메일 주소", github_login: "GitHub 아이디" }),
  }),

  teams: z
    .object({
      size: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([1, 10]),
    })
    .default({ size: [1, 10] }),

  /** Key = canonical track name. `aliases` are the values that may appear in the sheet. */
  tracks: z
    .record(
      z.string(),
      z.object({
        id: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
        template: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo")
          .optional(),
        aliases: z.array(z.string()).default([]),
      }),
    )
    .default({}),

  repo: z
    .object({
      /** Placeholders: {team_name} {team_no} {track_id} {track} {event_id} */
      name_pattern: z.string().default("{team_name}"),
      visibility: z.enum(["private", "public"]).default("private"),
      leader_permission: Permission.default("maintain"),
      member_permission: Permission.default("push"),
      ruleset: z
        .object({
          enabled: z.boolean().default(true),
          block_force_push: z.boolean().default(true),
          block_deletion: z.boolean().default(true),
        })
        .default({ enabled: true, block_force_push: true, block_deletion: true }),
      topics: z.array(z.string()).default(["{event_id}"]),
      /** README sections the visibility check looks for before a repo goes public. */
      readme_required_sections: z.array(z.string()).default([]),
    })
    .default({
      name_pattern: "{team_name}",
      visibility: "private",
      leader_permission: "maintain",
      member_permission: "push",
      ruleset: { enabled: true, block_force_push: true, block_deletion: true },
      topics: ["{event_id}"],
      readme_required_sections: [],
    }),

  reviewers: z
    .object({
      tab: z.string(),
      columns: z
        .object({
          name: z.string().default("이름"),
          github_login: z.string().default("GitHub 아이디"),
          role: z.string().default("역할"),
          teams: z.string().default("담당 팀"),
        })
        .default({ name: "이름", github_login: "GitHub 아이디", role: "역할", teams: "담당 팀" }),
      /** Reviewers only ever get read access. Anything else is rejected at load time. */
      permission: z.literal("pull").default("pull"),
      mode: z.literal("outside_collaborator").default("outside_collaborator"),
      expires_at: z.string().datetime({ offset: true }).optional(),
    })
    .optional(),

  schedule: z
    .object({
      start_at: z.string().datetime({ offset: true }).optional(),
      freeze_at: z.string().datetime({ offset: true }).optional(),
    })
    .default({}),

  /** Path relative to the event folder. */
  app_policy: z.string().default("../../policies/app-policy.yaml"),
});

export type EventConfig = z.infer<typeof EventConfigSchema>;

export const AppPolicySchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  require_selected_repos: z.boolean().default(true),
  allow_lowers_tier: z.number().int().min(0).max(1).default(1),
  deny_permissions: z
    .object({
      repository: z.array(z.string()).default(["secrets:write"]),
      /** Any organization-level write is rejected regardless of this list; extra entries add read-level denials. */
      organization: z.array(z.string()).default([]),
    })
    .default({ repository: ["secrets:write"], organization: [] }),
  review2_permissions: z
    .object({
      repository: z.array(z.string()).default(["administration:write", "workflows:write"]),
    })
    .default({ repository: ["administration:write", "workflows:write"] }),
});

export type AppPolicy = z.infer<typeof AppPolicySchema>;
