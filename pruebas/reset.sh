set -e
export PGHOST=/var/run/postgresql
P=/home/user/obras/mave-mujer-web/supabase; T=$(dirname "$0")
psql -q -d postgres -c 'drop database if exists mave' -c 'create database mave'
export PGDATABASE=mave
psql -v ON_ERROR_STOP=1 -q -f $T/bootstrap.sql
psql -v ON_ERROR_STOP=1 -q -f $P/01_esquema.sql 2>/dev/null
psql -v ON_ERROR_STOP=1 -q -f $P/02_productos_iniciales.sql
psql -q -c "insert into auth.users(id,email) values ('11111111-1111-1111-1111-111111111111','duena@mave.test'),('22222222-2222-2222-2222-222222222222','intruso@mave.test')"
psql -v ON_ERROR_STOP=1 -q -At -f $T/admin.sql >/dev/null
psql -v ON_ERROR_STOP=1 -q -f $P/05_inventario.sql
echo "BD reiniciada: $(psql -At -c 'select count(*) from public.products') productos"
