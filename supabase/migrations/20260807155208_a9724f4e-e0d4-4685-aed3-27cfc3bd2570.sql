create type public.app_role as enum ('admin','moderator','user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;
create policy "read own roles" on public.user_roles for select to authenticated using (auth.uid() = user_id);

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create table public.desktop_releases (
  id uuid primary key default gen_random_uuid(),
  platform text not null default 'macos',
  architecture text not null default 'apple_silicon',
  version text not null,
  file_url text not null,
  file_name text not null default 'InterviewCopilot-Companion.dmg',
  file_size bigint,
  minimum_os text,
  is_active boolean not null default false,
  is_test_build boolean not null default true,
  release_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.desktop_releases to anon;
grant select, insert, update, delete on public.desktop_releases to authenticated;
grant all on public.desktop_releases to service_role;
alter table public.desktop_releases enable row level security;
create policy "public can read active releases" on public.desktop_releases for select to anon, authenticated using (is_active = true);
create policy "admins read all releases" on public.desktop_releases for select to authenticated using (public.has_role(auth.uid(),'admin'));
create policy "admins manage releases" on public.desktop_releases for all to authenticated using (public.has_role(auth.uid(),'admin')) with check (public.has_role(auth.uid(),'admin'));

create trigger t_desktop_releases_upd before update on public.desktop_releases
for each row execute function public.set_updated_at();