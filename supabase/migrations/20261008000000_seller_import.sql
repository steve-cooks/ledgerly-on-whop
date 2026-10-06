-- Seller import from the operator console (/import), and recognising imported sellers at sign-in.

-- Imported sellers are matched by email when they first sign in (claimImportedSeller).
create index if not exists sellers_email_lower_idx on sellers (lower(email));

-- Who ran each console import and what it did (counts only; rows are in sellers).
create table seller_imports (
  id           bigserial primary key,
  imported_by  text not null,
  created      int not null,
  existing     int not null,
  errors       int not null,
  imported_at  timestamptz not null default now()
);

alter table seller_imports enable row level security;
