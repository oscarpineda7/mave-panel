-- MAVE Mujer · BORRAR TODO EL INVENTARIO (empezar de cero)
-- ¡Cuidado! Borra el historial de ventas y entradas, las unidades de todos los productos y los costos.
-- Los productos, fotos y precios de la tienda NO se tocan.
-- Úsalo solo para limpiar pruebas. No se puede deshacer.

begin;

-- Los productos que quedaron "Agotado" por la prueba vuelven a estar disponibles en la tienda.
update public.products
   set available = case when stock = 0 then true else available end,
       stock     = null,
       cost      = null
 where stock is not null or cost is not null;

delete from public.stock_movements;

commit;

select (select count(*) from public.stock_movements) as movimientos_que_quedan,
       (select count(*) from public.products where stock is not null) as productos_con_stock,
       (select count(*) from public.products where not available) as productos_agotados;
