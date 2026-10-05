import type { Handler } from "./webhooks";

/**
 * Event type -> handler. Unlisted types are recorded in webhook_events and acknowledged.
 * Handlers are filled in from real captured payloads (see notes in README).
 */
export const handlers: Partial<Record<string, Handler>> = {};
