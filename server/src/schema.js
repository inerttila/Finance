export async function ensureSchema(pool) {
  await pool.query(`
    create table if not exists users (
      id serial primary key,
      name text not null,
      auth_id text unique,
      created_at timestamptz not null default now()
    );

    alter table users add column if not exists auth_id text;
    create unique index if not exists users_auth_id_unique on users (auth_id);

    create table if not exists categories (
      user_id int not null references users(id),
      slug text not null,
      name text not null,
      color text not null,
      sort_order int not null,
      primary key (user_id, slug)
    );

    create table if not exists income (
      user_id int not null references users(id),
      month date not null,
      amount int not null check (amount >= 0),
      site_amount int not null default 0 check (site_amount >= 0),
      primary key (user_id, month)
    );

    create table if not exists transactions (
      id serial primary key,
      user_id int not null references users(id),
      amount int not null check (amount > 0),
      description text not null,
      category_slug text not null,
      people text[] not null default '{}',
      spent_on date not null,
      weekend boolean not null default false,
      sort_order int not null default 0,
      fixed boolean not null default false,
      created_at timestamptz not null default now(),
      foreign key (user_id, category_slug) references categories(user_id, slug)
    );

    create table if not exists fixed_templates (
      id serial primary key,
      user_id int not null references users(id) on delete cascade,
      amount int not null check (amount > 0),
      description text not null,
      category_slug text not null,
      day_of_month int not null check (day_of_month >= 1 and day_of_month <= 31),
      active boolean not null default true,
      sort_order int not null default 0,
      created_at timestamptz not null default now(),
      foreign key (user_id, category_slug) references categories(user_id, slug)
    );

    alter table transactions
      add column if not exists fixed_template_id int
      references fixed_templates(id) on delete set null;

    create index if not exists transactions_user_spent_idx on transactions (user_id, spent_on desc);
    create index if not exists fixed_templates_user_idx on fixed_templates (user_id, sort_order, id);
    create index if not exists transactions_fixed_template_idx
      on transactions (user_id, fixed_template_id, spent_on)
      where fixed_template_id is not null;
    create unique index if not exists users_name_unique_ci on users (lower(name));
  `);
}
