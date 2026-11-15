-- MAVE Mujer · Corregir errores del inventario
-- 07: botón "Deshacer" en los últimos movimientos de cada producto (ventas, entradas y conteos).
--     Al deshacer, el movimiento se borra del historial, el stock vuelve a como estaba y el
--     Resumen y el Excel dejan de contarlo.
-- Ejecutar una sola vez en Supabase > SQL Editor (después de 05 y 06). Es seguro volver a ejecutarlo:
-- NO borra ningún dato.

-- El registro automático del historial se salta cuando el cambio viene de "Deshacer".
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
  if coalesce(current_setting('mave.skip_log', true), '') = 'on' then return new; end if;
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

-- Deshacer un movimiento: lo quita del historial y devuelve el stock a como estaba.
create or replace function public.undo_movement(p_movement bigint)
returns public.products
language plpgsql
security definer
set search_path = ''
as $$
declare
  m         public.stock_movements;
  res       public.products;
  remaining integer;
begin
  if not coalesce((select private.is_admin()), false) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  select * into m from public.stock_movements where id = p_movement;
  if m.id is null then raise exception 'Ese movimiento ya se había deshecho.'; end if;

  -- Bloquear el producto: dos toques seguidos no pueden deshacer lo mismo dos veces.
  perform 1 from public.products where id = m.product_id for update;
  if not exists (select 1 from public.stock_movements where id = p_movement) then
    raise exception 'Ese movimiento ya se había deshecho.';
  end if;

  -- Si quitar una entrada dejaría el stock en negativo (porque esas unidades ya se vendieron), no se puede.
  if exists (select 1 from public.stock_movements
              where product_id = m.product_id and id > m.id and stock_after - m.delta < 0)
     or exists (select 1 from public.products where id = m.product_id and coalesce(stock, 0) - m.delta < 0) then
    raise exception 'No se puede deshacer: esas unidades ya se vendieron. Deshaz primero las ventas de después.';
  end if;

  update public.stock_movements set stock_after = stock_after - m.delta
   where product_id = m.product_id and id > m.id;
  delete from public.stock_movements where id = m.id;
  select count(*) into remaining from public.stock_movements where product_id = m.product_id;

  perform set_config('mave.skip_log', 'on', true);
  update public.products
     set stock     = case when remaining = 0 then null else coalesce(stock, 0) - m.delta end,
         available = case when remaining = 0 and stock = 0 then true else available end
   where id = m.product_id
  returning * into res;
  perform set_config('mave.skip_log', '', true);
  return res;
end;
$$;
revoke all on function public.undo_movement(bigint) from public, anon;
grant execute on function public.undo_movement(bigint) to authenticated;

select 'Listo: ya se puede deshacer desde el panel.' as listo;
