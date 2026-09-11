alter table public.users
  add column if not exists username text;

alter table public.users
  drop constraint if exists users_username_format_check;

alter table public.users
  add constraint users_username_format_check
  check (username is null or username ~ '^[a-z0-9][a-z0-9_]{2,29}$');

create unique index if not exists users_username_lower_unique
  on public.users (lower(username))
  where username is not null;

comment on column public.users.username is
  'Public workspace handle. Lowercase, 3-30 characters, letters numbers and underscores.';
