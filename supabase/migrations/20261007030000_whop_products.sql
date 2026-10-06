-- Which Whop product each of our SKUs became, per Whop account. Whop lets the platform key create
-- a product on a seller's account inline (by external_identifier) but not re-send it: a second
-- checkout for the same product must reference it by id.
create table whop_products (
  account_id           text not null,
  external_identifier  text not null,
  whop_product_id      text not null,
  created_at           timestamptz not null default now(),
  primary key (account_id, external_identifier)
);
alter table whop_products enable row level security;
