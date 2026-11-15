// MAVE Mujer · configuración compartida por la tienda (index.html) y el panel (admin.html).
// Aquí solo va la clave PÚBLICA de Supabase ("Publishable key" o "anon"), que está hecha para el navegador.
// Nunca pongas aquí la clave "secret" o "service_role".
// Si supabaseUrl o supabaseKey quedan vacíos, la tienda muestra el catálogo de respaldo y el panel avisa que falta configurar.
window.MAVE_CONFIG = {
  supabaseUrl: 'https://ockbclmyqtndivfjuxtb.supabase.co',
  supabaseKey: 'sb_publishable_gNPQBf-6ujrigem9jDaTUA_Wwu6JqN0',
  bucket: 'product-images',
  // Dirección de la tienda (el botón “Ver tienda” del panel lleva aquí).
  storeUrl: 'https://mavemujer.netlify.app/',
  categories: [
    { id: 'shampoo',     label: 'Shampoo' },
    { id: 'tratamiento', label: 'Acondicionadores y tratamientos' },
    { id: 'reparacion',  label: 'Reparadores y termoprotectores' },
    { id: 'accesorios',  label: 'Accesorios' },
    { id: 'cuerpo',      label: 'Cuidado corporal' }
  ]
};
