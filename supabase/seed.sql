-- Demo data for local development (`supabase db reset` runs this).
-- NOT for production: it fabricates auth users directly.

-- Demo owner + two friends
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'demo@wander.local', '', now(), '{"provider":"email","providers":["email"]}', '{}'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), '{}', '{}'),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), '{}', '{}')
on conflict (id) do nothing;

-- Trip (trigger auto-creates the owner member row)
insert into public.trips (id, owner_id, name, destination, description, start_date, end_date, estimated_budget, invite_code)
values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Tokyo Adventure',
  'Tokyo, Japan',
  'Cherry blossoms, ramen crawls and a day trip to Hakone.',
  current_date + 45,
  current_date + 53,
  3200,
  'demoinvite42'
);

insert into public.members (id, trip_id, user_id, display_name, color)
values
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'Maya', '#d97706'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'Sam', '#0e7490');

-- A poll with votes
insert into public.polls (id, trip_id, created_by, question, category)
values ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000002', 'Where should we stay?', 'stay');

insert into public.poll_options (id, trip_id, poll_id, label, position) values
  ('30000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Shinjuku — nightlife & transit', 0),
  ('30000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Asakusa — old town charm', 1),
  ('30000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Shibuya — the classic', 2);

insert into public.votes (trip_id, poll_id, option_id, member_id) values
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000003');

-- Checklist, itinerary, budget, packing, notes
insert into public.checklist_items (trip_id, title, assignee_id, due_date, created_by) values
  ('10000000-0000-0000-0000-000000000001', 'Book flights', '20000000-0000-0000-0000-000000000002', current_date + 10, '20000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000001', 'Reserve Shinjuku hotel', null, current_date + 14, '20000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000001', 'Buy travel insurance', null, current_date + 20, '20000000-0000-0000-0000-000000000002');

insert into public.itinerary_items (trip_id, title, category, day, start_time, location, created_by) values
  ('10000000-0000-0000-0000-000000000001', 'Flight NRT', 'flight', current_date + 45, '09:30', 'Narita Airport', '20000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000001', 'Ramen crawl', 'restaurant', current_date + 46, '18:00', 'Shinjuku', '20000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000001', 'TeamLab Planets', 'activity', current_date + 47, '11:00', 'Toyosu', '20000000-0000-0000-0000-000000000002');

insert into public.budget_entries (trip_id, title, category, estimated, actual, created_by) values
  ('10000000-0000-0000-0000-000000000001', 'Flights', 'transport', 900, 940, '20000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000001', 'Hotel (8 nights)', 'stay', 1200, null, '20000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000001', 'Food budget', 'food', 600, null, '20000000-0000-0000-0000-000000000002');

insert into public.packing_items (trip_id, name, category, added_by) values
  ('10000000-0000-0000-0000-000000000001', 'Passport', 'documents', '20000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000001', 'JR Pass voucher', 'documents', '20000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000001', 'Power adapter', 'electronics', '20000000-0000-0000-0000-000000000002');

insert into public.notes (trip_id, title, content, created_by) values
  ('10000000-0000-0000-0000-000000000001', 'Restaurant ideas',
   E'## Must try\n- Ichiran (Shinjuku)\n- Tsukiji outer market sushi\n- 7-Eleven egg sandos (trust us)',
   '20000000-0000-0000-0000-000000000003');

insert into public.activity (trip_id, member_id, verb, subject) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'created a poll', 'Where should we stay?'),
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'voted on', 'Where should we stay?');
