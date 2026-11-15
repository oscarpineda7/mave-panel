\set ON_ERROR_STOP 0
\pset tuples_only on
-- helpers: run a statement as a role/user and report OK / BLOQUEADO
create or replace function pg_temp.try(r text, uid text, stmt text) returns text language plpgsql as $$
declare n int; begin
  execute format('set local role %I', r);
  perform set_config('request.jwt.claims', coalesce(json_build_object('sub',uid,'role',r)::text,''), true);
  execute stmt; get diagnostics n = row_count;
  execute 'reset role';
  return 'filas afectadas: ' || n;
exception when others then
  execute 'reset role';
  return 'BLOQUEADO (' || sqlstate || ')';
end $$;
begin; update public.products set visible=false where id='masmelo'; commit;
\echo '1. Visitante anónimo: cuántos productos ve (deben ser 15, masmelo está oculto)'
begin; set local role anon; select count(*) from public.products; commit;
\echo '2. Visitante anónimo intenta cambiar un precio'
begin; select pg_temp.try('anon', null, $q$update public.products set price=1 where id='duveshi-oro'$q$); commit;
\echo '3. Visitante anónimo intenta crear un producto'
begin; select pg_temp.try('anon', null, $q$insert into public.products(id,name,category,price) values('hack','x','shampoo',1)$q$); commit;
\echo '4. Visitante anónimo intenta borrar'
begin; select pg_temp.try('anon', null, $q$delete from public.products$q$); commit;
\echo '5. Usuario con sesión pero NO admin intenta cambiar un precio (0 filas = bloqueado por RLS)'
begin; select pg_temp.try('authenticated', '22222222-2222-2222-2222-222222222222', $q$update public.products set price=1 where id='duveshi-oro'$q$); commit;
\echo '6. Usuario NO admin intenta crear producto'
begin; select pg_temp.try('authenticated', '22222222-2222-2222-2222-222222222222', $q$insert into public.products(id,name,category,price) values('hack','x','shampoo',1)$q$); commit;
\echo '7. Usuario NO admin intenta hacerse admin'
begin; select pg_temp.try('authenticated', '22222222-2222-2222-2222-222222222222', $q$insert into public.admins(user_id,email) values('22222222-2222-2222-2222-222222222222','intruso@mave.test')$q$); commit;
\echo '8. Usuario NO admin ve el producto oculto? (debe ser 0)'
begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222222"}',true); select count(*) from public.products where id='masmelo'; commit;
\echo '9. Usuario NO admin sube una foto'
begin; select pg_temp.try('authenticated', '22222222-2222-2222-2222-222222222222', $q$insert into storage.objects(bucket_id,name) values('product-images','products/hack.webp')$q$); commit;
\echo '10. Anónimo sube una foto'
begin; select pg_temp.try('anon', null, $q$insert into storage.objects(bucket_id,name) values('product-images','products/hack.webp')$q$); commit;
\echo '11. ADMIN ve el producto oculto (debe ser 1)'
begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111"}',true); select count(*) from public.products where id='masmelo'; commit;
\echo '12. ADMIN cambia un precio (dentro de transacción que se deshace)'
begin; select pg_temp.try('authenticated', '11111111-1111-1111-1111-111111111111', $q$update public.products set price=51000 where id='duveshi-oro'$q$); rollback;
\echo '13. ADMIN crea y borra producto, sube y borra foto (se deshace)'
begin; select pg_temp.try('authenticated', '11111111-1111-1111-1111-111111111111', $q$insert into public.products(id,name,category,price) values('prueba','Prueba','shampoo',1000)$q$);
select pg_temp.try('authenticated', '11111111-1111-1111-1111-111111111111', $q$delete from public.products where id='prueba'$q$);
select pg_temp.try('authenticated', '11111111-1111-1111-1111-111111111111', $q$insert into storage.objects(bucket_id,name) values('product-images','products/ok.webp')$q$);
select pg_temp.try('authenticated', '11111111-1111-1111-1111-111111111111', $q$delete from storage.objects where name='products/ok.webp'$q$); rollback;
\echo '14. Datos inválidos: precio negativo e id con espacios (como admin)'
begin; select pg_temp.try('authenticated', '11111111-1111-1111-1111-111111111111', $q$insert into public.products(id,name,category,price) values('ok-id','X','shampoo',-5)$q$);
select pg_temp.try('authenticated', '11111111-1111-1111-1111-111111111111', $q$insert into public.products(id,name,category,price) values('Mal Id','X','shampoo',5)$q$); rollback;
begin; update public.products set visible=true where id='masmelo'; commit;
\echo '15. updated_at cambia solo al editar'
select (select updated_at from public.products where id='lpp-termo') < now();
