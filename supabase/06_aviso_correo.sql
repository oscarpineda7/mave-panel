-- MAVE Mujer · Aviso por correo de poco stock
-- 06: cuando un producto baja hasta su mínimo ("Avisar cuando queden") o se agota, llega un correo.
-- Ejecutar una sola vez en Supabase > SQL Editor (después de 05). Es seguro volver a ejecutarlo.
--
-- Usa Resend (resend.com, gratis hasta 3.000 correos al mes). El correo llega a la cuenta de
-- administración (tabla admins), o a la guardada en Vault como 'alert_email' si existe.
-- ÚNICO CAMBIO ANTES DE EJECUTAR: al final de este archivo, reemplaza PEGA_AQUI_LA_CLAVE por la
-- clave de Resend (empieza por re_). Sin clave no se envía nada y todo lo demás funciona igual.

create extension if not exists pg_net with schema extensions;

create or replace function private.notify_low_stock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p        record;
  api_key  text;
  to_email text;
  before   integer := new.stock_after - new.delta;
  subj     text;
  msg      text;
begin
  -- Solo cuando el stock BAJA y cruza el mínimo (o llega a 0): un aviso por cruce, no uno por cada venta.
  if new.delta >= 0 then return new; end if;
  select id, name, brand, min_stock into p from public.products where id = new.product_id;
  if p.id is null then return new; end if;
  if not ((new.stock_after <= p.min_stock and before > p.min_stock) or (new.stock_after = 0 and before > 0)) then
    return new;
  end if;

  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  select decrypted_secret into to_email from vault.decrypted_secrets where name = 'alert_email' limit 1;
  if to_email is null then select a.email into to_email from public.admins a order by a.created_at limit 1; end if;
  if api_key is null or to_email is null then return new; end if;

  if new.stock_after = 0 then
    subj := 'Agotado: ' || p.name;
    msg  := 'Se vendió la última unidad de <b>' || p.name || '</b>. En la tienda ya aparece como “Agotado”.';
  else
    subj := 'Poco stock: ' || p.name || ' (quedan ' || new.stock_after || ')';
    msg  := 'A <b>' || p.name || '</b> le quedan <b>' || new.stock_after || '</b> unidades. Es momento de pedir mercancía.';
  end if;

  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || api_key, 'Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'from', 'MAVE Mujer <onboarding@resend.dev>',
      'to', jsonb_build_array(to_email),
      'subject', subj,
      'html', '<div style="font-family:Arial,sans-serif;font-size:16px;color:#33203B">'
              || '<p style="font-size:13px;letter-spacing:2px;color:#B07C86">MAVE MUJER · INVENTARIO</p>'
              || '<p>' || msg || '</p>'
              || '<p><a href="https://oscarpineda7.github.io/mave-panel/admin.html#p=' || p.id || '" '
              || 'style="background:#7E4F9C;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none">Abrir en el panel</a></p>'
              || '</div>'
    )
  );
  return new;
exception when others then
  -- Un problema con el correo nunca debe impedir registrar una venta.
  return new;
end;
$$;
revoke all on function private.notify_low_stock() from public;

drop trigger if exists stock_movements_low_stock_email on public.stock_movements;
create trigger stock_movements_low_stock_email
  after insert on public.stock_movements
  for each row execute function private.notify_low_stock();

-- ─────────────────────────────────────────────────────────────
-- Clave de Resend: reemplaza PEGA_AQUI_LA_CLAVE (deja las comillas).
-- ─────────────────────────────────────────────────────────────
do $$
declare
  k text := trim('PEGA_AQUI_LA_CLAVE');
begin
  if k not like 're\_%' then
    raise exception 'Falta la clave de Resend: reemplaza PEGA_AQUI_LA_CLAVE por tu clave (empieza por re_) y vuelve a tocar Run.';
  end if;
  delete from vault.secrets where name = 'resend_api_key';
  perform vault.create_secret(k, 'resend_api_key');
end $$;

-- Debe mostrar a dónde llegarán los avisos.
select 'Los avisos llegarán a: ' || coalesce(
  (select decrypted_secret from vault.decrypted_secrets where name = 'alert_email' limit 1),
  (select email from public.admins order by created_at limit 1)) as listo;
