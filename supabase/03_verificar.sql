-- MAVE Mujer · Catálogo de productos
-- 03: comprobar que la migración quedó completa. Solo lee, no cambia nada.

-- Debe dar 16 (o más, si ya agregaste productos nuevos desde el panel).
select count(*) as total_productos from public.products;

-- Debe devolver 0 filas: ningún producto original falta.
select id as falta
from unnest(array[
  'duveshi-shampoo','duveshi-frutal','duveshi-oro','choco-shampoo','choco-acond','miel-shampoo',
  'miel-acond','lamour-polimero','lehit-cebolla-sh','lehit-cebolla-trat','lehit-seda-sh',
  'lehit-seda-trat','lpp-shampoo','lpp-termo','lamour-medias','masmelo'
]) as id
where id not in (select p.id from public.products p);

-- Precios de los productos originales, para compararlos con la web anterior.
select id, brand, name, category, price, image_url, available, visible
from public.products
order by sort_order, created_at;

-- Debe mostrar tu correo: es la cuenta que puede entrar al panel.
select email, created_at from public.admins;
