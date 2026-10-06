import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { runOpsJob } from "@/lib/ops-job";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Scheduled by vercel.json. Vercel Cron authenticates with "Authorization: Bearer $CRON_SECRET". */
export async function GET(req: Request) {
  const secret = env().CRON_SECRET ?? "";
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runOpsJob();
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
