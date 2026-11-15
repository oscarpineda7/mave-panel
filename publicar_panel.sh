#!/usr/bin/env bash
# Publica el panel (sitio/admin.html y lo que necesita) en la rama gh-pages → GitHub Pages.
# La tienda sigue en Netlify; aquí solo va el panel. La raíz redirige a admin.html.
set -euo pipefail
cd "$(dirname "$0")"
TMP=$(mktemp -d)
cp -r sitio/admin.html sitio/admin.js sitio/config.js sitio/vendor sitio/img "$TMP"/
printf 'User-agent: *\nDisallow: /\n' > "$TMP/robots.txt"
printf '%s\n' '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="robots" content="noindex">' \
  '<meta http-equiv="refresh" content="0; url=admin.html"><title>Panel MAVE Mujer</title></head>' \
  '<body><a href="admin.html">Ir al panel de MAVE Mujer</a></body></html>' > "$TMP/index.html"
touch "$TMP/.nojekyll"
REMOTE=$(git remote get-url origin)
cd "$TMP" && git init -q -b gh-pages && git add -A && git commit -qm "Publicar panel desde main ($(date +%F))" ${GIT_COMMIT_ARGS:-}
git push -f "$REMOTE" gh-pages
