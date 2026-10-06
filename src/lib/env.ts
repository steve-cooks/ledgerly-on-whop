import { z } from "zod";

const schema = z.object({
  WHOP_API_KEY: z.string().min(1).optional(),
  WHOP_PLATFORM_ACCOUNT_ID: z.string().startsWith("biz_"),
  WHOP_WEBHOOK_SECRET: z.string().startsWith("ws_").optional(),
  DATABASE_URL: z.string().url(),
  // Bearer token Ledgerly's backend uses to call /api/sellers, /api/checkouts, /api/reconcile.
  ADMIN_API_TOKEN: z.string().min(32).optional(),
  // Vercel Cron sends "Authorization: Bearer $CRON_SECRET" to /api/cron/*.
  CRON_SECRET: z.string().min(16).optional(),
  // Optional Slack-compatible incoming webhook for ops alerts.
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  // Signs the demo seller session cookie.
  SESSION_SECRET: z.string().min(32).default("dev-only-insecure-session-secret-change-me"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  // Ledgerly's take rate, in basis points (800 = 8%).
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(800),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` doesn't need runtime secrets. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
