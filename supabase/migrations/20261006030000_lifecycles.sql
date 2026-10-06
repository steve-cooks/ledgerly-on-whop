-- Review fixes: real lifecycles for transfers, refunds and disputes; idempotent checkouts;
-- deferred webhook events.

-- Transfers: what they're for, Whop's own status, and a failed state (a transfer id is not
-- proof of payment).
alter table seller_transfers drop constraint seller_transfers_status_check;
alter table seller_transfers add constraint seller_transfers_status_check
  check (status in ('pending', 'completed', 'failed'));
alter table seller_transfers add column purpose text not null default 'order_share'
  check (purpose in ('order_share', 'refund_funding', 'payout_advance'));
update seller_transfers set purpose = 'refund_funding' where idempotence_key like '%:refund_funding';
update seller_transfers set purpose = 'payout_advance' where idempotence_key like '%:payout_advance%';
alter table seller_transfers add column whop_status text;

-- Orders: the caller's request key makes checkout creation idempotent; seller_share records
-- what a platform-collected seller is owed (set at settlement) so reconciliation can check it.
alter table orders add column request_key text unique;
alter table orders add column purchase_url text;
alter table orders add column seller_share numeric(18, 2);

-- Refunds: only a succeeded refund moves money; booked_at marks that it has been applied.
alter table refunds add column status text not null default 'succeeded';
alter table refunds add column booked_at timestamptz;
update refunds set booked_at = created_at where status = 'succeeded';

-- Disputes: one row per Whop dispute; the order is held while it's open.
create table disputes (
  whop_dispute_id  text primary key,
  order_id         uuid not null references orders (id),
  status           text not null,
  amount           numeric(18, 2),
  currency         text,
  updated_at       timestamptz not null default now()
);
alter table disputes enable row level security;

-- Webhook inbox: events whose subject isn't known yet are deferred and retried by the ops job.
alter table webhook_events add column attempts int not null default 0;
