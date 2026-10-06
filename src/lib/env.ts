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
  // Optional: where the hourly job's runs can be seen (e.g. the Vercel project's Cron Jobs page).
  // The console's "Books vs Whop" card links there.
  OPS_JOB_URL: z.string().url().optional(),
  // Demo sign-in (stand-in for Ledgerly's auth). Off unless explicitly enabled; no default secret.
  DEMO_LOGIN_ENABLED: z.enum(["true", "false"]).default("false"),
  SESSION_SECRET: z.string().min(32).optional(),
  // "Sign in with Whop" for operators: the OAuth app's client id (app_…). Sign-in is off without it.
  WHOP_OAUTH_CLIENT_ID: z.string().startsWith("app_").optional(),
  // Its client secret (the app's OAuth tab, "Confidential" mode). Never sent to the browser.
  WHOP_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  // The seller-facing "Ledgerly" Whop app, used for sellers' "Continue with Whop" sign-in. The
  // key is the app's OAuth client secret.
  WHOP_SELLER_APP_ID: z.string().startsWith("app_").optional(),
  WHOP_SELLER_APP_KEY: z.string().min(1).optional(),
  // Supabase Auth (seller sign-in on the demo marketplace) and Storage (product files).
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
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
