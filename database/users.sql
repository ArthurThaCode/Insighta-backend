-- Insighta Labs+ Stage 3 users table
-- Run this in Supabase SQL editor before testing GitHub OAuth.

create table if not exists public.users (
  id uuid primary key,
  github_id varchar unique not null,
  username varchar not null,
  email varchar,
  avatar_url varchar,
  role varchar not null default 'analyst' check (role in ('admin', 'analyst')),
  is_active boolean not null default true,
  last_login_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create index if not exists users_github_id_idx on public.users (github_id);
create index if not exists users_role_idx on public.users (role);
