# MAVE Mujer · Tienda con panel de productos

## Dónde está publicado
- **Tienda:** Netlify → <https://mavemujer.netlify.app/>
- **Panel (productos + inventario):** GitHub Pages → <https://oscarpineda7.github.io/mave-panel/admin.html>
  Se publica solo cada vez que cambia la rama `main` (`.github/workflows/panel.yml`, fuente de Pages: GitHub Actions). Alternativa: `./publicar_panel.sh` publica en la rama `gh-pages`.
  También funciona en Netlify (`/admin.html`) si se vuelve a subir la carpeta `sitio/`.

## Inventario (noviembre 2026)
- Cada producto tiene **unidades en stock** y **“avisar cuando queden”** (por defecto 3).
- En el panel: botones **−** y **+** en cada producto; tocar el número abre el detalle con “Llegó mercancía”, “Conté la estantería”, el historial y la etiqueta QR.
- Al llegar a **0** el producto pasa solo a **“Agotado”** en la tienda; al volver a sumar unidades se activa de nuevo.
- Arriba aparece un aviso con los productos con **poco stock** (filtro “Poco stock”).
- **Etiquetas QR:** se imprimen desde el panel. Al escanearlas con la cámara del celular se abre el panel en ese producto.
- Base de datos: `supabase/05_inventario.sql` (columnas `stock`, `min_stock`, tabla `stock_movements`, funciones `adjust_stock` y `set_stock`). Los visitantes de la tienda no pueden ver cuántas unidades hay.
- **Ventas:** el botón **−** registra una venta con el precio de la tienda y el canal elegido arriba (**Local** u **Online / WhatsApp**). En el detalle del producto, “Vendí” permite poner otra cantidad, otro precio (descuento) y el canal.
- **Costo:** cada producto puede tener su costo (no se ve en la tienda). “Llegó mercancía” pregunta cuánto se pagó por unidad y actualiza el costo.
- **Pestaña Resumen:** vendido (por canal), ganancia, gastado en mercancía, valor del inventario, ventas por día y lo más vendido, por periodo. **Descargar Excel** trae 5 hojas: Resumen, Ventas por día, Por producto, Movimientos e Inventario.
- **Aviso por correo:** `supabase/06_aviso_correo.sql` envía un correo (vía Resend) cuando un producto baja hasta su mínimo o se agota. Necesita dos claves en Supabase Vault: `resend_api_key` y `alert_email`.
- Pruebas: `pruebas/e2e_inventario.js`, `pruebas/e2e_ventas.js` (y `pruebas/e2e.js` de la tienda).

## Qué hay en esta carpeta

| Carpeta / archivo | Para qué sirve |
|---|---|
| `sitio/` | **Lo que se sube a Netlify.** Arrastra esta carpeta completa. |
| `sitio/index.html` | La tienda. Mismo diseño de antes; ahora lee los productos de Supabase. |
| `sitio/admin.html` + `admin.js` | El panel de productos (privado, con inicio de sesión). |
| `sitio/config.js` | Dirección y clave **pública** de Supabase. Es lo único que hay que llenar. |
| `sitio/vendor/supabase-2.118.0.js` | Librería oficial de Supabase (copia local, sin depender de otro servidor). |
| `sitio/img/` | Las 16 fotos originales. No las borres: los productos migrados las usan. |
| `sitio/_headers`, `robots.txt` | Seguridad en Netlify y que Google no indexe el panel. |
| `supabase/01…04_*.sql` | Lo que se pega en Supabase › SQL Editor, en orden. |
| `respaldo/` | Copia exacta de la web anterior y de los 16 productos (JSON). |
| `pruebas/` | Pruebas automáticas usadas durante el desarrollo (no se suben a Netlify). |

## Instalación

### Ya está hecho (4 de noviembre de 2026)
- Proyecto de Supabase **mave-mujer** creado en la organización "Oscar pineda" (plan gratuito, región us-east-1).
  Panel de Supabase: <https://supabase.com/dashboard/project/ockbclmyqtndivfjuxtb>
- Tablas, políticas de seguridad y bucket de fotos (`01_esquema.sql`).
- Los 16 productos migrados (`02_productos_iniciales.sql`), verificados campo por campo contra `respaldo/productos-v1.json`.
- `sitio/config.js` ya tiene la dirección y la clave pública del proyecto.
- Revisión de seguridad de Supabase (Advisors): sin avisos.

### Falta (solo lo puede hacer la dueña de la cuenta, ~10 minutos)
1. **Crear la cuenta de la dueña:** Supabase › **Authentication › Users › Add user › Create new user**. Escribe el correo y una contraseña segura, y marca **Auto Confirm User**.
2. **Darle permiso de administradora:** **SQL Editor › New query**, pega `supabase/04_crear_admin.sql`, cambia `CORREO_DE_LA_DUEÑA@ejemplo.com` por ese correo y pulsa **Run**. Debe mostrar el correo.
3. **Cerrar el registro público:** **Authentication › Sign In / Providers** › desactiva **Allow new users to sign up**.
4. **Publicar en Netlify:** en tu sitio › **Deploys**, arrastra la carpeta `sitio/` completa (no solo el `index.html`).
5. **Enlace de recuperación de contraseña:** **Authentication › URL Configuration** › en *Site URL* pon la dirección de Netlify (ej. `https://mavemujer.netlify.app`) y en *Redirect URLs* agrega `https://mavemujer.netlify.app/admin.html`.
6. **Comprobar:** abre `https://TU-SITIO.netlify.app/admin.html`, entra con la cuenta de la dueña y revisa que salgan los 16 productos. Ejecuta `supabase/03_verificar.sql` si quieres ver el resumen.

Desde aquí, **los cambios de productos ya no necesitan volver a publicar en Netlify.** Solo hay que volver a subir la carpeta si se cambia el diseño o `config.js`.

## Uso diario (desde el celular)
1. Abre `https://TU-SITIO.netlify.app/admin.html` (guárdalo en la pantalla de inicio).
2. **Agregar producto** › elige la foto › nombre, categoría, precio (solo números, ej. `42000`) › **Publicar producto**.
3. En cada producto: interruptor **Disponible** (apagado = “Agotado”), interruptor **Visible** (apagado = oculto), **Editar**, **Eliminar** (pide confirmación y ofrece “Solo ocultar”).
4. Recarga la tienda: el cambio ya se ve.

## Volver a la versión anterior
Sube `respaldo/index-v1-estatico.html` a Netlify renombrado como `index.html`. Es la web tal como estaba, con las fotos incluidas en el archivo.

## Seguridad
- La clave de `config.js` es pública por diseño; lo que protege los datos son las políticas **RLS** de `01_esquema.sql`:
  visitantes solo leen productos visibles; solo las cuentas de la tabla `admins` crean, editan, borran o suben fotos.
- Nadie puede agregarse a `admins` desde la web; solo desde el SQL Editor de Supabase.
- Fotos: máximo 5 MB, solo JPG/PNG/WebP; el panel las reduce a 1200 px antes de subirlas.
- `_headers` añade CSP, bloqueo de iframes y `noindex` para el panel.

## Costos
- **Supabase Free:** $0. 500 MB de base de datos, 1 GB de fotos (~5.000 fotos), 5 GB de transferencia al mes.
  Limitación: si el proyecto pasa **7 días sin actividad**, Supabase lo pausa (avisa por correo antes). Las visitas a la tienda cuentan como actividad. Si se pausa: Dashboard › **Resume project**. Mientras esté pausado, la tienda muestra la última copia guardada o el catálogo de respaldo.
- **Supabase Pro** (opcional, sin pausas, copias de seguridad diarias): USD 25/mes.
- **Netlify:** el plan gratuito alcanza para una tienda de este tamaño.
- **Dominio propio** (opcional): ~COP 50.000–60.000 al año.
