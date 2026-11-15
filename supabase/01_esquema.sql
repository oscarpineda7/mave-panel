-- MAVE Mujer · Catálogo de productos
-- 01: tablas, seguridad (RLS) y almacenamiento de fotos.
-- Ejecutar una sola vez en Supabase > SQL Editor. Es seguro volver a ejecutarlo.

-- ─────────────────────────────────────────────────────────────
-- Administradores: solo las cuentas listadas aquí pueden editar.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Cada administrador solo puede ver su propia fila (el panel la usa para comprobar permisos).
drop policy if exists "admins_select_own" on public.admins;
create policy "admins_select_own" on public.admins
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Nadie puede agregarse como administrador desde la web: no hay políticas de insert/update/delete.
revoke insert, update, delete on public.admins from anon, authenticated;

-- La comprobación de administrador vive en un esquema que la API REST no expone.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;

revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- Productos
-- ─────────────────────────────────────────────────────────────
create table if not exists public.products (
  id          text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  brand       text not null default '',
  name        text not null check (length(trim(name)) > 0),
  category    text not null,
  price       integer not null check (price >= 0),
  size        text not null default '',
  badge       text not null default '',
  short_desc  text not null default '',
  description text not null default '',
  tags        text[] not null default '{}',
  items       text[] not null default '{}',
  image_url   text not null default '',
  image_path  text,                       -- ruta en Storage si la foto se subió desde el panel
  available   boolean not null default true,  -- false = "Agotado"
  visible     boolean not null default true,  -- false = oculto en la tienda
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists products_visible_order_idx on public.products (visible, sort_order, created_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

alter table public.products enable row level security;

-- La tienda pública solo ve productos visibles. Los administradores ven todos.
drop policy if exists "products_select" on public.products;
create policy "products_select" on public.products
  for select to anon, authenticated
  using (visible or (select private.is_admin()));

drop policy if exists "products_insert_admin" on public.products;
create policy "products_insert_admin" on public.products
  for insert to authenticated
  with check ((select private.is_admin()));

drop policy if exists "products_update_admin" on public.products;
create policy "products_update_admin" on public.products
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

drop policy if exists "products_delete_admin" on public.products;
create policy "products_delete_admin" on public.products
  for delete to authenticated
  using ((select private.is_admin()));

-- Defensa extra: los visitantes anónimos no tienen permiso de escritura aunque falle una política.
revoke insert, update, delete, truncate on public.products from anon;
grant select on public.products to anon, authenticated;
grant insert, update, delete on public.products to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Fotos: bucket público de solo lectura; solo administradores suben o borran.
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "product_images_admin_select" on storage.objects;
create policy "product_images_admin_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images' and (select private.is_admin()));

drop policy if exists "product_images_admin_insert" on storage.objects;
create policy "product_images_admin_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and (select private.is_admin()));

drop policy if exists "product_images_admin_update" on storage.objects;
create policy "product_images_admin_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and (select private.is_admin()))
  with check (bucket_id = 'product-images' and (select private.is_admin()));

drop policy if exists "product_images_admin_delete" on storage.objects;
create policy "product_images_admin_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and (select private.is_admin()));
