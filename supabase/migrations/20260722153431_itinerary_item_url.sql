-- #41: optional link on itinerary items — the page of the restaurant/hotel/
-- activity being planned. Text, validated client-side as http(s); RLS and the
-- realtime publication for itinerary_items are unchanged (new columns of a
-- published table replicate automatically).
alter table public.itinerary_items
  add column if not exists url text;
