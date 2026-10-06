// Sweep: pay sellers for any paid platform orders whose share hasn't been transferred.
//   pnpm tsx scripts/settle-orders.ts
import "./_setup";
import { sql } from "@/lib/db";
import { settlePlatformOrder } from "@/lib/checkout";

async function main() {
  const orders = await sql()`
    select o.id from orders o
    where o.flow = 'platform' and o.status = 'paid'
      and not exists (select 1 from seller_transfers t where t.order_id = o.id and t.whop_transfer_id is not null)`;
  for (const o of orders) console.log(o.id, JSON.stringify(await settlePlatformOrder(o.id)));
}
main().finally(() => sql().end());
