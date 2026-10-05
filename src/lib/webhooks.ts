import type postgres from "postgres";

/** The Standard Webhooks envelope Whop sends. Only the fields we route on are typed. */
export type WhopEvent = {
  id: string; // msg_..., same value as the webhook-id header
  type: string;
  timestamp: string;
  api_version_date?: string | null;
  // `account_id` on payloads pinned to 2026-08-14 or later, `company_id` on older/unpinned ones.
  account_id?: string | null;
  company_id?: string | null;
  data: Record<string, unknown>;
};

/**
 * Which Whop account (biz_...) an event belongs to. Tolerates both envelope versions,
 * then falls back to fields on the object itself.
 */
export function eventAccountId(event: WhopEvent): string | null {
  const d = event.data ?? {};
  const nested = (k: string) => {
    const v = d[k];
    return v && typeof v === "object" && "id" in v ? String((v as { id: unknown }).id) : null;
  };
  return (
    event.account_id ??
    event.company_id ??
    (typeof d.account_id === "string" ? d.account_id : null) ??
    (typeof d.company_id === "string" ? d.company_id : null) ??
    nested("account") ??
    nested("company") ??
    null
  );
}

export type Tx = postgres.TransactionSql;

export type HandlerContext = {
  tx: Tx;
  event: WhopEvent;
  accountId: string | null;
  sellerExternalId: string | null;
};

export type Handler = (ctx: HandlerContext) => Promise<void>;
