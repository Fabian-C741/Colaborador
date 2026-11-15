-- =====================================================================
-- Esquema: Panel de recaudacion para evento
-- Ejecutar en Supabase > SQL Editor
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- PROFILES (usuarios y roles). id = auth.users.id
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null default 'colaborador' check (role in ('admin','colaborador')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- EVENTS
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'active' check (status in ('active','closed')),
  target_amount numeric(14,2),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- PRODUCTS (catalogo a precio fijo)
-- ---------------------------------------------------------------------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  price numeric(14,2) not null check (price >= 0),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists products_event_idx on public.products(event_id, active, sort);

-- ---------------------------------------------------------------------
-- SALES (ventas)
-- method: efectivo | qr | transferencia
-- status: pending | confirmed | rejected | unassigned
-- ---------------------------------------------------------------------
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  collaborator_id uuid references public.profiles(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  unit_price numeric(14,2) not null,
  quantity int not null check (quantity > 0),
  total numeric(14,2) not null,
  method text not null check (method in ('efectivo','qr','transferencia')),
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','unassigned')),
  mp_order_id text,
  mp_payment_id text unique,
  mp_movement_id text unique,
  client_uuid uuid unique,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles(id) on delete set null,
  confirmed_at timestamptz
);
create index if not exists sales_event_idx on public.sales(event_id, created_at desc);
create index if not exists sales_collab_idx on public.sales(collaborator_id, created_at desc);
create index if not exists sales_status_idx on public.sales(status);

-- ---------------------------------------------------------------------
-- SETTLEMENTS (rendiciones / arqueo)
-- ---------------------------------------------------------------------
create table if not exists public.settlements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  collaborator_id uuid not null references public.profiles(id) on delete cascade,
  expected_cash numeric(14,2) not null default 0,
  declared_cash numeric(14,2) not null default 0,
  counted_cash numeric(14,2),
  difference numeric(14,2),
  note text,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  confirmed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index if not exists settlements_event_idx on public.settlements(event_id, created_at desc);

-- ---------------------------------------------------------------------
-- APP SETTINGS (branding). Fila unica id = 1
-- ---------------------------------------------------------------------
create table if not exists public.app_settings (
  id int primary key default 1 check (id = 1),
  event_id uuid references public.events(id) on delete set null,
  event_name text not null default 'Mi Evento',
  logo_url text,
  favicon_url text,
  background_url text,
  primary_color text not null default '#5b8cff',
  secondary_color text not null default '#3f6fe0',
  footer_text text not null default 'Todos los derechos reservados',
  theme text not null default 'dark' check (theme in ('dark','light')),
  privacy_text text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- AUDIT LOG (inmutable, solo insert)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id bigserial primary key,
  actor_id uuid,
  actor_name text,
  action text not null,
  entity text,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_created_idx on public.audit_log(created_at desc);

-- ---------------------------------------------------------------------
-- WEBHOOK EVENTS (dedup de notificaciones MP)
-- ---------------------------------------------------------------------
create table if not exists public.webhook_events (
  id text primary key,
  topic text,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- HELPERS de autorizacion (security definer para evitar recursion RLS)
-- =====================================================================
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.active);
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.active);
$$;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.profiles      enable row level security;
alter table public.events        enable row level security;
alter table public.products      enable row level security;
alter table public.sales         enable row level security;
alter table public.settlements   enable row level security;
alter table public.app_settings  enable row level security;
alter table public.audit_log     enable row level security;
alter table public.webhook_events enable row level security;

-- profiles: cada uno ve el suyo; admin ve todos. Escritura solo backend (service role).
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_admin());

-- events: lectura para autenticados; escritura solo admin.
drop policy if exists events_select on public.events;
create policy events_select on public.events for select using (public.is_staff());
drop policy if exists events_write on public.events;
create policy events_write on public.events for all
  using (public.is_admin()) with check (public.is_admin());

-- products: lectura para autenticados; escritura admin.
drop policy if exists products_select on public.products;
create policy products_select on public.products for select using (public.is_staff());
drop policy if exists products_write on public.products;
create policy products_write on public.products for all
  using (public.is_admin()) with check (public.is_admin());

-- sales: colaborador ve/inserta las suyas; admin ve todas y confirma.
drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales for select
  using (public.is_admin() or collaborator_id = auth.uid());
drop policy if exists sales_insert on public.sales;
create policy sales_insert on public.sales for insert
  with check (public.is_admin() or (collaborator_id = auth.uid() and created_by = auth.uid()));
drop policy if exists sales_update on public.sales;
create policy sales_update on public.sales for update
  using (public.is_admin()) with check (public.is_admin());

-- settlements: colaborador ve/crea las suyas; admin confirma.
drop policy if exists settlements_select on public.settlements;
create policy settlements_select on public.settlements for select
  using (public.is_admin() or collaborator_id = auth.uid());
drop policy if exists settlements_insert on public.settlements;
create policy settlements_insert on public.settlements for insert
  with check (public.is_admin() or collaborator_id = auth.uid());
drop policy if exists settlements_update on public.settlements;
create policy settlements_update on public.settlements for update
  using (public.is_admin()) with check (public.is_admin());

-- app_settings: lectura publica (branding); escritura admin.
drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select using (true);
drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_write on public.app_settings for all
  using (public.is_admin()) with check (public.is_admin());

-- audit_log: solo admin lee; inserts via backend/trigger (service role, saltea RLS).
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select using (public.is_admin());

-- webhook_events: solo backend.
drop policy if exists webhook_select on public.webhook_events;
create policy webhook_select on public.webhook_events for select using (public.is_admin());

-- =====================================================================
-- TRIGGERS de auditoria (append-only)
-- =====================================================================
create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_name text;
begin
  select name into v_name from public.profiles where id = v_actor;
  insert into public.audit_log(actor_id, actor_name, action, entity, entity_id, details)
  values (
    v_actor,
    coalesce(v_name, 'sistema'),
    tg_op,
    tg_table_name,
    coalesce((case when tg_op = 'DELETE' then old.id else new.id end)::text, ''),
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists audit_sales on public.sales;
create trigger audit_sales after insert or update or delete on public.sales
  for each row execute function public.audit_trigger();

drop trigger if exists audit_products on public.products;
create trigger audit_products after insert or update or delete on public.products
  for each row execute function public.audit_trigger();

drop trigger if exists audit_settlements on public.settlements;
create trigger audit_settlements after insert or update or delete on public.settlements
  for each row execute function public.audit_trigger();

drop trigger if exists audit_settings on public.app_settings;
create trigger audit_settings after insert or update or delete on public.app_settings
  for each row execute function public.audit_trigger();

-- =====================================================================
-- REALTIME (publicar cambios de sales)
-- =====================================================================
alter publication supabase_realtime add table public.sales;
