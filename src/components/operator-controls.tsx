import { env } from "@/lib/env";
import { REMINDER_COOLDOWN_MS, lastReminder } from "@/lib/operator";

/** Operator-only controls shared by the console's seller list and a seller's status page. */

export function timeAgo(date: Date, now: number) {
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function hoursUntil(date: Date, now: number) {
  return Math.max(1, Math.ceil((date.getTime() - now) / 3_600_000));
}

/** "Send reminder", or why it can't be sent right now. `now` is the request time. */
export function ReminderButton({ externalId, back, lastSentAt, now }: { externalId: string; back: string; lastSentAt: Date | null; now: number }) {
  const nextAt = lastSentAt ? new Date(lastSentAt.getTime() + REMINDER_COOLDOWN_MS) : null;
  if (nextAt && nextAt.getTime() > now) {
    return (
      <span
        className="inline-flex cursor-not-allowed items-center rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-subtle"
        title={`One reminder per day. Available again in ${hoursUntil(nextAt, now)}h.`}
      >
        Reminded
      </span>
    );
  }
  return (
    <form action={`/api/operator/sellers/${encodeURIComponent(externalId)}/reminder`} method="post">
      <input type="hidden" name="back" value={back} />
      <button
        type="submit"
        className="inline-flex items-center whitespace-nowrap rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
      >
        Send reminder
      </button>
    </form>
  );
}

const MODES = [
  { value: "direct", label: "Direct" },
  { value: "platform", label: "Platform" },
] as const;

export function modeExplainer() {
  const pct = env().PLATFORM_FEE_BPS / 100;
  return {
    direct: `Buyers pay the seller's Whop account; Ledgerly keeps ${pct}% as an application fee.`,
    platform: `Ledgerly collects the payment and transfers the seller's share.`,
  };
}

/** Two-option payment-mode switch. The current mode is shown pressed; the other submits. */
export function ModeToggle({ externalId, mode, back }: { externalId: string; mode: "direct" | "platform"; back: string }) {
  const explain = modeExplainer();
  return (
    <form
      action={`/api/operator/sellers/${encodeURIComponent(externalId)}/mode`}
      method="post"
      className="inline-flex rounded-lg border border-line bg-bg p-0.5 text-xs font-medium"
      aria-label="Payment mode for new purchases"
    >
      <input type="hidden" name="back" value={back} />
      {MODES.map((m) =>
        m.value === mode ? (
          <span key={m.value} aria-current="true" className="rounded-md bg-surface px-2.5 py-1 text-ink shadow-[0_1px_2px_rgba(15,26,23,0.08)]" title={explain[m.value]}>
            {m.label}
          </span>
        ) : (
          <button
            key={m.value}
            type="submit"
            name="mode"
            value={m.value}
            title={`Switch to ${m.label.toLowerCase()} for new purchases. ${explain[m.value]}`}
            className="rounded-md px-2.5 py-1 text-muted transition hover:text-ink"
          >
            {m.label}
          </button>
        ),
      )}
    </form>
  );
}

const MODE_NAMES = { direct: "direct charges", platform: "platform collection" };

/** The outcome of an operator action, from the redirect's query string. */
export async function OperatorNotice({ notice, seller, now }: { notice?: string; seller?: string; now: number }) {
  if (!notice) return null;
  const who = seller ?? "The seller";
  let tone: "good" | "warn" | "bad" = "good";
  let text: string;
  switch (notice) {
    case "reminder_sent":
      text = `Reminder sent: ${who} will see it on their Ledgerly status page.`;
      break;
    case "reminder_cooldown": {
      tone = "warn";
      const last = seller ? await lastReminder(seller) : null;
      text = last
        ? `${who} was already reminded ${timeAgo(last.sent_at, now)}. You can send another in ${hoursUntil(new Date(last.sent_at.getTime() + REMINDER_COOLDOWN_MS), now)}h.`
        : `${who} was reminded in the last 24 hours.`;
      break;
    }
    case "mode_direct":
    case "mode_platform":
      text = `${who} now uses ${MODE_NAMES[notice === "mode_direct" ? "direct" : "platform"]} for new purchases. Existing orders keep their original flow.`;
      break;
    case "mode_unchanged":
      tone = "warn";
      text = `${who} was already on that payment mode. Nothing changed.`;
      break;
    case "reminder_not_found":
    case "mode_not_found":
      tone = "bad";
      text = `Seller ${who} wasn't found.`;
      break;
    default:
      tone = "bad";
      text = "Something went wrong and nothing was changed. Please try again.";
  }
  const cls = { good: "bg-accent-soft text-accent-ink", warn: "bg-warn-soft text-warn", bad: "bg-danger-soft text-danger" }[tone];
  return (
    <p role="status" className={`rounded-xl px-4 py-3 text-sm ${cls}`}>
      {text}
    </p>
  );
}

/** The time this request is rendered at (dynamic pages render once per request). */
export function requestTime() {
  return Date.now();
}
