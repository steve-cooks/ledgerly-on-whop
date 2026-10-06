-- Demo marketplace: seller sign-in (Supabase Auth) and the products buyers can buy.

-- A Supabase Auth user (auth.users.id) who sells on Ledgerly. One store per user. No foreign
-- key to auth.users so this schema stands on its own (tests run without Supabase's auth schema).
create table seller_users (
  auth_user_id        uuid primary key,
  seller_external_id  text unique not null references sellers (external_id),
  store_name          text not null,
  created_at          timestamptz not null default now()
);

create table products (
  id                  uuid primary key default gen_random_uuid(),
  seller_external_id  text not null references sellers (external_id),
  title               text not null,
  description         text,
  price               numeric(18, 2) not null check (price >= 1),
  sku                 text unique not null,              -- stable; Whop finds-or-creates its product by it
  file_path           text,                              -- object in the private 'deliverables' bucket
  file_name           text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index products_seller_idx on products (seller_external_id, created_at desc);

-- The product an order was for (null for orders created through the API).
alter table orders add column product_id uuid references products (id);
create index orders_product_idx on orders (product_id);

alter table seller_users enable row level security;
alter table products enable row level security;
