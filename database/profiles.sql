-- Insighta Labs profiles table
-- Run this in the Supabase SQL editor before seeding (see "Database setup" in the README).

create table if not exists public.profiles (
  id uuid primary key,
  name varchar not null unique,
  gender varchar not null check (gender in ('male', 'female')),
  gender_probability double precision not null,
  age integer not null,
  age_group varchar not null check (age_group in ('child', 'teenager', 'adult', 'senior')),
  country_id varchar(2) not null,
  country_name varchar,
  country_probability double precision not null,
  created_at timestamp with time zone not null default now()
);

-- Columns used by the filters and the sort options of GET /api/v1/profiles
create index if not exists profiles_gender_idx on public.profiles (gender);
create index if not exists profiles_age_group_idx on public.profiles (age_group);
create index if not exists profiles_country_id_idx on public.profiles (country_id);
create index if not exists profiles_age_idx on public.profiles (age);
create index if not exists profiles_gender_probability_idx on public.profiles (gender_probability);
create index if not exists profiles_country_probability_idx on public.profiles (country_probability);
create index if not exists profiles_created_at_idx on public.profiles (created_at);
