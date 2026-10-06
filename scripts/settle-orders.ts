// Sweep: settle every paid platform order (settlePlatformOrder only sends what's still owed).
//   pnpm tsx scripts/settle-orders.ts
import "./_setup";
import { sql } from "@/lib/db";
import { settlePlatformOrder } from "@/lib/checkout";

async function main() {
  const orders = await sql()`
    select o.id from orders o
    where o.flow = 'platform' and o.status = 'paid'`;
  for (const o of orders) console.log(o.id, JSON.stringify(await settlePlatformOrder(o.id)));
}
main().finally(() => sql().end());
