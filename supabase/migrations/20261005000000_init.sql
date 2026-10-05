-- Ledgerly <> Whop: local state for a platform with connected accounts.
-- Money is stored as numeric major units (Whop's API uses decimal major units, never cents).

create table sellers (
  external_id      text primary key,                 -- Ledgerly's own seller id
  email            text not null,
  country          char(2) not null,
  whop_account_id  text unique,                      -- biz_... connected account
  -- 'direct'   : buyer pays the seller's connected account, Ledgerly takes an application fee
  -- 'platform' : seller may never take payments directly; Ledgerly charges and transfers the share
  collection_mode  text not null default 'direct' check (collection_mode in ('direct', 'platform')),
  whop_status      text,                             -- mirrored from account.updated (active / suspended)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table orders (
  id                         uuid primary key default gen_random_uuid(),
  seller_external_id         text not null references sellers (external_id),
  flow                       text not null check (flow in ('direct', 'platform')),
  title                      text not null,
  amount                     numeric(18, 2) not null check (amount > 0),
  currency                   text not null,
  platform_fee               numeric(18, 2) not null check (platform_fee >= 0),
  checkout_configuration_id  text unique,
  whop_payment_id            text unique,
  status                     text not null default 'pending'
                             check (status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed')),
  refunded_amount            numeric(18, 2) not null default 0,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

-- Seller share moved by Ledgerly for 'platform' orders (separate charge + transfer).
create table seller_transfers (
  id                 uuid primary key default gen_random_uuid(),
  seller_external_id text not null references sellers (external_id),
  order_id           uuid references orders (id),
  amount             numeric(18, 2) not null check (amount > 0),
  currency           text not null,
  idempotence_key    text not null unique,
  whop_transfer_id   text unique,
  status             text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One row per payout (wdrl_ id). payout.* and legacy withdrawal.* events for the same payout
-- update this row instead of posting twice.
create table payouts (
  whop_payout_id     text primary key,
  seller_external_id text references sellers (external_id),
  whop_account_id    text not null,
  status             text not null,
  amount             numeric(18, 2),
  currency           text,
  last_event_at      timestamptz not null,
  updated_at         timestamptz not null default now()
);

-- Append-only local ledger. entry_key makes every posting idempotent.
create table ledger_entries (
  id                 bigserial primary key,
  entry_key          text not null unique,          -- e.g. 'payment:pay_123:sale'
  seller_external_id text references sellers (external_id),
  kind               text not null check (kind in ('sale', 'platform_fee', 'refund', 'transfer_in', 'payout')),
  amount             numeric(18, 2) not null,       -- signed, from the seller's point of view
  currency           text not null,
  whop_object_id     text not null,
  occurred_at        timestamptz not null,
  created_at         timestamptz not null default now()
);
create index ledger_entries_seller_idx on ledger_entries (seller_external_id, occurred_at);

-- Webhook inbox: the primary key on the Standard Webhooks message id is what makes
-- processing exactly-once across retries, replays and restarts.
create table webhook_events (
  webhook_id        text primary key,               -- webhook-id header (msg_...)
  type              text not null,
  account_id        text,                           -- account_id, or company_id on older payload versions
  api_version_date  text,
  payload           jsonb not null,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  error             text
);

-- Server-side only: no anon/authenticated access through Supabase's REST API.
alter table sellers enable row level security;
alter table orders enable row level security;
alter table seller_transfers enable row level security;
alter table payouts enable row level security;
alter table ledger_entries enable row level security;
alter table webhook_events enable row level security;
