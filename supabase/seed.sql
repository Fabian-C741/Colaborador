-- =====================================================================
-- Datos iniciales. Ejecutar DESPUES de schema.sql
-- (El primer usuario admin se crea desde el backend con BOOTSTRAP_ADMIN_*)
-- =====================================================================

insert into public.events (id, name, status)
values ('00000000-0000-0000-0000-000000000001', 'Evento de recaudación', 'active')
on conflict (id) do nothing;

insert into public.products (event_id, name, price, sort)
values
  ('00000000-0000-0000-0000-000000000001', 'Docena de empanadas', 8000, 1),
  ('00000000-0000-0000-0000-000000000001', 'Gaseosa', 1500, 2),
  ('00000000-0000-0000-0000-000000000001', 'Porción de torta', 2500, 3)
on conflict do nothing;

insert into public.app_settings (id, event_id, event_name, footer_text, primary_color, secondary_color)
values (
  1,
  '00000000-0000-0000-0000-000000000001',
  'Evento de recaudación',
  '© ' || extract(year from now()) || ' Evento de recaudación',
  '#5b8cff',
  '#3f6fe0'
)
on conflict (id) do nothing;
