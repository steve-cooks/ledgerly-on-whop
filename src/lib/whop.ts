import { WhopClient } from "@whop/sdk";
import { env } from "./env";

export const WHOP_API_VERSION = "2026-09-29";

let client: WhopClient | undefined;

/** Platform (Ledgerly) client, authenticated with the Account API key. */
export function whop(): WhopClient {
  const token = env().WHOP_API_KEY;
  if (!token) throw new Error("WHOP_API_KEY is not set");
  client ??= new WhopClient({ token, apiVersionDate: WHOP_API_VERSION });
  return client;
}
