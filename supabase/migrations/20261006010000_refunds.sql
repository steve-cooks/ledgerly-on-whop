-- One row per Whop refund, so replays/duplicates can't inflate orders.refunded_amount.
create table refunds (
  whop_refund_id  text primary key,
  order_id        uuid not null references orders (id),
  amount          numeric(18, 2) not null,
  currency        text not null,
  created_at      timestamptz not null default now()
);
alter table refunds enable row level security;
