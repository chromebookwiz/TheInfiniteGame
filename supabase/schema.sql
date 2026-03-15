create extension if not exists pgcrypto;

create table if not exists public.campaign_saves (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  game_state jsonb not null,
  selected_npc_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists campaign_saves_user_updated_idx
  on public.campaign_saves (user_id, updated_at desc);

alter table public.campaign_saves enable row level security;

create policy "campaign saves are readable by owner"
  on public.campaign_saves
  for select
  using (auth.uid() = user_id);

create policy "campaign saves are insertable by owner"
  on public.campaign_saves
  for insert
  with check (auth.uid() = user_id);

create policy "campaign saves are updateable by owner"
  on public.campaign_saves
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "campaign saves are deletable by owner"
  on public.campaign_saves
  for delete
  using (auth.uid() = user_id);