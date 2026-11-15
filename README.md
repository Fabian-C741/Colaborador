# Panel de recaudación para evento

PWA para gestionar la recaudación de un evento: venta de productos a precio fijo en
**efectivo** (funciona offline) y por **QR de Mercado Pago**, con **doble control**,
**conciliación**, **auditoría** y **personalización** de marca.

## Arquitectura

- **Frontend**: PWA en `public/` (HTML + JS vanilla, sin build). Usa el cliente de
  Supabase (auth, datos con RLS, tiempo real) y un service worker para uso offline.
- **Backend**: la app Express (`server.js` + `src/`) para lo que necesita secretos:
  alta de usuarios, creación de órdenes de Mercado Pago, webhook firmado y
  sincronización de transferencias. En Vercel se despliega zero-config (detecta el
  `server.js`) como una única función; en local corre con `server.js`.
- **Base de datos**: Supabase (Postgres + Auth + Realtime). Esquema en `supabase/schema.sql`.
- **Deploy**: Vercel (frontend + funciones + cron).

```
public/            PWA (index.html login, app.html panel, js/, css/)
src/               app Express, rutas, cliente Supabase admin, integración MP
server.js          entrada Express (local y detección zero-config en Vercel)
supabase/          schema.sql, seed.sql
scripts/           bootstrap-admin.js
```

## Puesta en marcha

### 1. Supabase

1. Creá un proyecto en https://supabase.com (región más cercana, p. ej. São Paulo).
2. En **SQL Editor** ejecutá `supabase/schema.sql` y luego `supabase/seed.sql`.
3. En **Project Settings > API** copiá: `Project URL`, `anon public` y `service_role`.

### 2. Mercado Pago (cuenta dedicada al evento)

1. Usá una cuenta de Mercado Pago **exclusiva del evento**.
2. En https://www.mercadopago.com.ar/developers/panel creá una aplicación y copiá el
   **Access Token** de producción.
3. Configurá el webhook: URL `https://TU-DOMINIO/api/webhooks/mercadopago`,
   eventos **Pagos (payment)**. Copiá el **Signature secret**.

### 3. Variables de entorno

Copiá `.env.example` a `.env` y completá:

```
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
MP_ACCESS_TOKEN=...
MP_WEBHOOK_SECRET=...
BASE_URL=http://localhost:3000
CRON_SECRET=una-cadena-larga-aleatoria
```

### 4. Crear el primer administrador

```
npm install
npm run bootstrap -- admin@evento.com "ClaveSegura123" "Tu Nombre"
```

### 5. Correr en local

```
npm run dev        # http://localhost:3000
```

Ingresá con el admin creado y, desde **Admin > Colaboradores**, creá las cuentas del equipo.

### 6. Deploy en Vercel

1. Importá el repositorio en Vercel.
2. Cargá las mismas variables de entorno (Project Settings > Environment Variables),
   con `BASE_URL` = la URL de producción.
3. Deploy. El cron `/api/cron/sync-transfers` sincroniza transferencias cada 5 minutos.

> Requiere plan **Vercel Pro** (el uso comercial no está permitido en Hobby y los cron
> de 5 minutos necesitan Pro) y **Supabase Pro** en producción (backups/PITR y sin pausas).

## Cómo funciona

- **Vender**: el colaborador elige productos (carrito) y cobra.
  - **Efectivo**: se registra como *pendiente*; el administrador lo confirma al
    **rendir el arqueo** (doble control).
  - **QR**: se crea una venta *pendiente* y una preferencia de Mercado Pago; se muestra
    el QR. El webhook (firmado) confirma el pago automáticamente. Hay *polling* de respaldo.
- **Offline**: si no hay conexión, las ventas en efectivo se guardan en IndexedDB
  (cola con `client_uuid` único) y se sincronizan al volver la conexión, de forma idempotente.
- **Rendición**: el colaborador declara cuánto efectivo entrega; el admin lo cuenta,
  registra la diferencia y confirma. Al confirmar, se confirman sus ventas en efectivo.
- **Transferencias**: no hay webhook de transferencias recibidas; el cron las trae como
  ventas *sin asignar* y el admin las asigna a un colaborador.
- **Auditoría**: cada cambio en ventas, productos, rendiciones y ajustes queda en
  `audit_log` (append-only, disparado por triggers).

## Seguridad y cumplimiento

- Auth gestionado por Supabase (contraseñas con hash, JWT cortos, rotación).
- **RLS** en todas las tablas: el colaborador sólo ve/crea lo propio; el admin ve todo.
- **Service role** sólo en el backend (nunca en el frontend).
- Webhook de MP validado con **HMAC-SHA256** (`x-signature`), tolerancia de timestamp y
  deduplicación por `type:id`.
- La tarjeta nunca toca la app (Checkout Pro) → alcance **PCI SAQ A**.
- Supabase (ISO/IEC 27001:2022, SOC 2, PCI DSS) y Vercel (ISO 27001, SOC 2, PCI DSS) son
  los proveedores; el hardening propio queda como evidencia para un SGSI alineado a ISO 27001.
- Privacidad (Argentina, Ley 25.326): minimización de datos (sólo nombre y email),
  aviso de privacidad editable en Ajustes, retención y borrado vía Supabase.

## Limitaciones conocidas

- `src/mp/client.js` usa `/v1/account/movements/search` para las transferencias. Según la
  cuenta, ese endpoint puede requerir el **Reporte de "Todas las transacciones"**; si no
  está disponible, el cron lo informa (`notAvailable`) sin romper. Ajustar si hace falta.
