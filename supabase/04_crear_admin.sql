-- MAVE Mujer · Catálogo de productos
-- 04: dar permiso de administración a la cuenta de la dueña.
-- Antes: crea el usuario en Supabase > Authentication > Users > Add user > Create new user
--        (marca "Auto Confirm User"). Luego cambia el correo de abajo y ejecuta.

insert into public.admins (user_id, email)
select id, email from auth.users where email = 'CORREO_DE_LA_DUEÑA@ejemplo.com'
on conflict (user_id) do nothing;

-- Debe mostrar 1 fila con ese correo. Si sale vacío, el correo no coincide con el usuario creado.
select email from public.admins;
