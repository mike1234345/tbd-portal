-- =====================================================
-- TBD Marketing Solutions — Messages Schema (v3 upgrade-safe)
-- Adds modern chat features:
--   - named group chats
--   - pinned chats
--   - badge colors / avatars
--   - add/remove members
--   - soft delete messages
-- Safe to run on top of an existing messages setup.
-- =====================================================

create extension if not exists pgcrypto;

create table if not exists public.crm_conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete cascade
);

create table if not exists public.crm_conversation_participants (
  conversation_id uuid not null references public.crm_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);

create table if not exists public.crm_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.crm_conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '' check (char_length(coalesce(body, '')) >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.crm_conversations add column if not exists title text;
alter table public.crm_conversations add column if not exists is_pinned boolean not null default false;
alter table public.crm_conversations add column if not exists pinned_at timestamptz;
alter table public.crm_conversations add column if not exists pinned_by uuid references auth.users(id) on delete set null;
alter table public.crm_conversations add column if not exists badge_color text;

alter table public.crm_messages add column if not exists deleted_at timestamptz;
alter table public.crm_messages add column if not exists deleted_by uuid references auth.users(id) on delete set null;

create index if not exists crm_conversations_updated_at_idx on public.crm_conversations(updated_at desc);
create index if not exists crm_conversations_pinned_idx on public.crm_conversations(is_pinned, updated_at desc);
create index if not exists crm_conversation_participants_user_idx on public.crm_conversation_participants(user_id, conversation_id);
create index if not exists crm_messages_conversation_idx on public.crm_messages(conversation_id, created_at desc);
create index if not exists crm_messages_deleted_idx on public.crm_messages(deleted_at);

create or replace function public.crm_is_messages_admin(check_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crm_user_roles r
    where r.user_id = check_user
      and r.role = 'admin'
  );
$$;

create or replace function public.crm_is_conversation_participant(conv_id uuid, check_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crm_conversation_participants p
    where p.conversation_id = conv_id
      and p.user_id = check_user
  );
$$;

create or replace function public.crm_can_manage_conversation(conv_id uuid, check_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.crm_conversations c
    where c.id = conv_id
      and (c.created_by = check_user or public.crm_is_messages_admin(check_user))
  );
$$;

grant execute on function public.crm_is_messages_admin(uuid) to authenticated;
grant execute on function public.crm_is_conversation_participant(uuid, uuid) to authenticated;
grant execute on function public.crm_can_manage_conversation(uuid, uuid) to authenticated;

create or replace function public.crm_touch_conversation_from_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.crm_conversations
     set updated_at = now()
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists crm_touch_conversation_from_message on public.crm_messages;
create trigger crm_touch_conversation_from_message
after insert or update on public.crm_messages
for each row execute function public.crm_touch_conversation_from_message();

alter table public.crm_conversations enable row level security;
alter table public.crm_conversation_participants enable row level security;
alter table public.crm_messages enable row level security;

-- Conversations

drop policy if exists "crm_conversations_select_participants" on public.crm_conversations;
create policy "crm_conversations_select_participants"
on public.crm_conversations
for select
to authenticated
using (
  created_by = auth.uid()
  or public.crm_is_conversation_participant(id, auth.uid())
);

drop policy if exists "crm_conversations_insert_own" on public.crm_conversations;
create policy "crm_conversations_insert_own"
on public.crm_conversations
for insert
to authenticated
with check (
  created_by = auth.uid()
);

drop policy if exists "crm_conversations_update_participants" on public.crm_conversations;
create policy "crm_conversations_update_participants"
on public.crm_conversations
for update
to authenticated
using (
  created_by = auth.uid()
  or public.crm_is_conversation_participant(id, auth.uid())
)
with check (
  created_by = auth.uid()
  or public.crm_is_conversation_participant(id, auth.uid())
);

-- Participants

drop policy if exists "crm_participants_select_if_member" on public.crm_conversation_participants;
create policy "crm_participants_select_if_member"
on public.crm_conversation_participants
for select
to authenticated
using (
  public.crm_is_conversation_participant(conversation_id, auth.uid())
);

drop policy if exists "crm_participants_insert_creator_or_self" on public.crm_conversation_participants;
create policy "crm_participants_insert_creator_or_self"
on public.crm_conversation_participants
for insert
to authenticated
with check (
  user_id = auth.uid()
  or public.crm_can_manage_conversation(conversation_id, auth.uid())
);

drop policy if exists "crm_participants_update_own_read_state" on public.crm_conversation_participants;
create policy "crm_participants_update_own_read_state"
on public.crm_conversation_participants
for update
to authenticated
using (
  user_id = auth.uid()
  or public.crm_can_manage_conversation(conversation_id, auth.uid())
)
with check (
  user_id = auth.uid()
  or public.crm_can_manage_conversation(conversation_id, auth.uid())
);

drop policy if exists "crm_participants_delete_member_or_manager" on public.crm_conversation_participants;
create policy "crm_participants_delete_member_or_manager"
on public.crm_conversation_participants
for delete
to authenticated
using (
  user_id = auth.uid()
  or public.crm_can_manage_conversation(conversation_id, auth.uid())
);

-- Messages

drop policy if exists "crm_messages_select_if_member" on public.crm_messages;
create policy "crm_messages_select_if_member"
on public.crm_messages
for select
to authenticated
using (
  public.crm_is_conversation_participant(conversation_id, auth.uid())
);

drop policy if exists "crm_messages_insert_if_member" on public.crm_messages;
create policy "crm_messages_insert_if_member"
on public.crm_messages
for insert
to authenticated
with check (
  sender_id = auth.uid()
  and public.crm_is_conversation_participant(conversation_id, auth.uid())
);

drop policy if exists "crm_messages_update_sender_or_admin" on public.crm_messages;
create policy "crm_messages_update_sender_or_admin"
on public.crm_messages
for update
to authenticated
using (
  (sender_id = auth.uid() or public.crm_is_messages_admin(auth.uid()))
  and public.crm_is_conversation_participant(conversation_id, auth.uid())
)
with check (
  (sender_id = auth.uid() or public.crm_is_messages_admin(auth.uid()))
  and public.crm_is_conversation_participant(conversation_id, auth.uid())
);

-- Realtime publication

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'crm_conversations'
  ) then
    alter publication supabase_realtime add table public.crm_conversations;
  end if;
exception when undefined_object then null;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'crm_conversation_participants'
  ) then
    alter publication supabase_realtime add table public.crm_conversation_participants;
  end if;
exception when undefined_object then null;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'crm_messages'
  ) then
    alter publication supabase_realtime add table public.crm_messages;
  end if;
exception when undefined_object then null;
end $$;

notify pgrst, 'reload schema';
