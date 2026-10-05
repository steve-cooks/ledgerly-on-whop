import { sql } from "@/lib/db";

export async function GET() {
  const [{ now }] = await sql()`select now()`;
  return Response.json({ ok: true, db: now });
}
