-- MAVE Mujer · Inventario y ventas
-- 05: unidades en stock por producto, mínimo para aviso, costo, historial de entradas/ventas
--     con su valor en pesos, y "Agotado" automático cuando el stock llega a 0.
-- Ejecutar una sola vez en Supabase > SQL Editor (después de 01). Es seguro volver a ejecutarlo.

-- ─────────────────────────────────────────────────────────────
-- Columnas nuevas en productos
--   stock      = unidades disponibles. Vacío (null) = todavía no se lleva la cuenta de este producto.
--   min_stock  = cuando el stock queda en este número o menos, el panel lo marca como "poco stock".
-- ─────────────────────────────────────────────────────────────
alter table public.products add column if not exists stock integer;
alter table public.products add column if not exists min_stock integer not null default 3;
-- cost = lo que le cuesta a la tienda cada unidad (opcional). Solo lo ve el panel.
alter table public.products add column if not exists cost integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_stock_nonneg') then
    alter table public.products add constraint products_stock_nonneg check (stock is null or stock >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_min_stock_nonneg') then
    alter table public.products add constraint products_min_stock_nonneg check (min_stock >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_cost_nonneg') then
    alter table public.products add constraint products_cost_nonneg check (cost is null or cost >= 0);
  end if;
end $$;

-- La tienda pública no necesita ver cuántas unidades hay: los visitantes solo pueden leer
-- las columnas que usa la tienda. El panel (cuentas de administración) ve todo.
revoke select on public.products from anon;
grant select (id, brand, name, category, price, size, badge, short_desc, description, tags, items,
              image_url, image_path, available, visible, sort_order, created_at, updated_at)
  on public.products to anon;

-- ─────────────────────────────────────────────────────────────
-- Historial de movimientos (solo lectura para el panel; lo llena la base de datos sola)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.stock_movements (
  id          bigint generated always as identity primary key,
  product_id  text not null references public.products (id) on delete cascade,
  delta       integer not null,                  -- +3 = entraron 3, -1 = salió 1
  stock_after integer not null,
  reason      text not null default 'ajuste',    -- entrada (compra), salida (venta), conteo, inicial, ajuste
  unit_price  integer,                           -- precio de venta de 1 unidad en ese momento
  unit_cost   integer,                           -- costo de 1 unidad en ese momento (si se conoce)
  channel     text,                              -- solo ventas: 'fisica' (local) u 'online' (web / WhatsApp)
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);
alter table public.stock_movements add column if not exists unit_price integer;
alter table public.stock_movements add column if not exists unit_cost integer;
alter table public.stock_movements add column if not exists channel text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_channel_chk') then
    alter table public.stock_movements add constraint stock_movements_channel_chk check (channel is null or channel in ('fisica', 'online'));
  end if;
end $$;
create index if not exists stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create index if not exists stock_movements_created_idx on public.stock_movements (created_at);

alter table public.stock_movements enable row level security;

drop policy if exists "stock_movements_select_admin" on public.stock_movements;
create policy "stock_movements_select_admin" on public.stock_movements
  for select to authenticated
  using ((select private.is_admin()));

revoke all on public.stock_movements from anon;
revoke insert, update, delete, truncate on public.stock_movements from authenticated;
grant select on public.stock_movements to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Reglas automáticas
-- ─────────────────────────────────────────────────────────────
-- 1) Llega a 0 → "Agotado". Vuelve a tener unidades (desde 0 o desde "sin contar") → "Disponible".
--    Si el stock no cambia, el interruptor "Disponible" del panel se respeta tal cual.
create or replace function private.stock_availability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.stock = 0 then new.available := false; end if;
  elsif new.stock is distinct from old.stock then
    if new.stock = 0 then
      new.available := false;
    elsif new.stock > 0 and coalesce(old.stock, 0) = 0 then
      new.available := true;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists products_stock_availability on public.products;
create trigger products_stock_availability
  before insert or update of stock on public.products
  for each row execute function private.stock_availability();

-- 2) Cada cambio de stock queda anotado en el historial, venga de donde venga.
create or replace function private.log_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d integer;
  r text := nullif(current_setting('mave.stock_reason', true), '');
  p integer := nullif(current_setting('mave.unit_price', true), '')::integer;
  c integer := nullif(current_setting('mave.unit_cost', true), '')::integer;
  ch text := nullif(current_setting('mave.channel', true), '');
begin
  if new.stock is null then return new; end if;
  if tg_op = 'UPDATE' and new.stock is not distinct from old.stock then return new; end if;
  d := new.stock - coalesce(case when tg_op = 'UPDATE' then old.stock end, 0);
  if d = 0 and tg_op = 'UPDATE' then return new; end if;
  insert into public.stock_movements (product_id, delta, stock_after, reason, unit_price, unit_cost, channel, created_by)
  values (new.id, d, new.stock,
          coalesce(r, case when tg_op = 'INSERT' or old.stock is null then 'inicial' else 'ajuste' end),
          coalesce(p, new.price), coalesce(c, new.cost),
          case when coalesce(r, '') = 'salida' then ch end,
          (select auth.uid()));
  return new;
end;
$$;
revoke all on function private.log_stock_movement() from public;

drop trigger if exists products_log_stock on public.products;
create trigger products_log_stock
  after insert or update of stock on public.products
  for each row execute function private.log_stock_movement();

-- ─────────────────────────────────────────────────────────────
-- Funciones que usa el panel (respetan las mismas políticas: solo administradoras)
-- ─────────────────────────────────────────────────────────────
-- Sumar o restar unidades (botones + y −). Es atómico: dos toques seguidos nunca se pisan.
-- p_unit_price: precio real de venta si fue distinto (descuento). p_unit_cost: lo que se pagó por unidad
-- al comprar mercancía; también queda como nuevo costo del producto.
drop function if exists public.adjust_stock(text, integer, text);
drop function if exists public.adjust_stock(text, integer, text, integer, integer);
create or replace function public.adjust_stock(p_id text, p_delta integer, p_reason text default null,
                                               p_unit_price integer default null, p_unit_cost integer default null,
                                               p_channel text default null)
returns public.products
language plpgsql
set search_path = ''
as $$
declare
  res public.products;
begin
  if p_delta is null or p_delta = 0 then raise exception 'La cantidad debe ser distinta de 0.'; end if;
  perform set_config('mave.stock_reason',
    coalesce(nullif(p_reason, ''), case when p_delta > 0 then 'entrada' else 'salida' end), true);
  if p_unit_price is not null and p_unit_price < 0 then raise exception 'El precio no puede ser negativo.'; end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'El costo no puede ser negativo.'; end if;
  perform set_config('mave.unit_price', coalesce(p_unit_price::text, ''), true);
  perform set_config('mave.unit_cost', coalesce(p_unit_cost::text, ''), true);
  if p_channel is not null and p_channel not in ('fisica', 'online') then raise exception 'Canal no válido.'; end if;
  perform set_config('mave.channel', coalesce(p_channel, ''), true);
  update public.products
     set stock = coalesce(stock, 0) + p_delta,
         cost = case when p_delta > 0 and p_unit_cost is not null then p_unit_cost else cost end
   where id = p_id
  returning * into res;
  if res.id is null then raise exception 'permission denied' using errcode = '42501'; end if;
  return res;
end;
$$;

-- Fijar el número exacto (al contar lo que hay en la estantería, o al crear el producto).
create or replace function public.set_stock(p_id text, p_stock integer, p_reason text default 'conteo')
returns public.products
language plpgsql
set search_path = ''
as $$
declare
  res public.products;
begin
  perform set_config('mave.stock_reason', coalesce(nullif(p_reason, ''), 'conteo'), true);
  perform set_config('mave.unit_price', '', true);
  perform set_config('mave.unit_cost', '', true);
  perform set_config('mave.channel', '', true);
  update public.products set stock = p_stock where id = p_id returning * into res;
  if res.id is null then raise exception 'permission denied' using errcode = '42501'; end if;
  return res;
end;
$$;

revoke all on function public.adjust_stock(text, integer, text, integer, integer, text) from public, anon;
revoke all on function public.set_stock(text, integer, text) from public, anon;
grant execute on function public.adjust_stock(text, integer, text, integer, integer, text) to authenticated;
grant execute on function public.set_stock(text, integer, text) to authenticated;
