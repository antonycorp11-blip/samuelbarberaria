-- Samuel Barbearia: schema inicial.
-- As regras críticas ficam também no banco: mesmo com bug no app, os dados não corrompem.
-- Dinheiro em centavos (integer). Percentuais em basis points (4500 = 45%).

create extension if not exists btree_gist;

create type user_role as enum ('owner', 'barber');
create type appointment_status as enum ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show');
create type payment_method as enum ('pix', 'cash', 'debit', 'credit');

create table settings (
  id boolean primary key default true check (id),
  data jsonb not null
);

create table barbers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  email text not null default '',
  phone text not null default '',
  service_bps int not null check (service_bps between 0 and 10000),
  product_bps int not null check (product_bps between 0 and 10000),
  active boolean not null default true,
  days_off int[] not null default '{}',
  break_start time,
  break_end time,
  check ((break_start is null) = (break_end is null)),
  check (break_end is null or break_end > break_start)
);

-- Liga o login do Supabase Auth ao papel na barbearia.
create table profiles (
  user_id uuid primary key,
  role user_role not null,
  barber_id uuid references barbers (id),
  check (role = 'owner' or barber_id is not null)
);

create table services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_cents int not null check (price_cents >= 0),
  duration_min int not null check (duration_min > 0 and duration_min % 5 = 0),
  active boolean not null default true
);

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) >= 2),
  phone text not null unique check (phone ~ '^[0-9]{10,11}$'),
  email text not null default '',
  birthday text check (birthday ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  notes text not null default '',
  marketing_opt_in boolean not null default false,
  stamps int not null default 0 check (stamps >= 0),
  rewards int not null default 0 check (rewards >= 0),
  created_at timestamptz not null default now()
);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id),
  barber_id uuid not null references barbers (id),
  service_ids uuid[] not null check (cardinality(service_ids) > 0),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status appointment_status not null default 'scheduled',
  source text not null default 'staff' check (source in ('staff', 'online', 'fit_in')),
  notes text not null default '',
  sale_id uuid,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Dois clientes clicando no mesmo horário ao mesmo tempo: só um passa.
  constraint no_double_booking exclude using gist (
    barber_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('scheduled', 'confirmed', 'in_progress', 'completed'))
);
create index appointments_day on appointments (starts_at);
create index appointments_client on appointments (client_id);

create table blocks (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid references barbers (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null default '',
  check (ends_at > starts_at)
);

create table waitlist (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id),
  service_ids uuid[] not null,
  barber_id uuid references barbers (id),
  date date not null,
  status text not null default 'waiting' check (status in ('waiting', 'notified', 'booked', 'expired')),
  created_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sale_price_cents int not null check (sale_price_cents >= 0),
  avg_cost_cents int not null default 0 check (avg_cost_cents >= 0),
  qty int not null default 0 check (qty >= 0),
  min_qty int not null default 0 check (min_qty >= 0),
  active boolean not null default true
);

create table coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code)),
  type text not null check (type in ('percent', 'fixed')),
  value int not null check (value > 0),
  min_cents int not null default 0,
  max_uses int,
  uses int not null default 0 check (uses >= 0),
  valid_from date not null,
  valid_to date not null,
  active boolean not null default true,
  check (valid_to >= valid_from),
  check (type <> 'percent' or value <= 10000),
  check (max_uses is null or uses <= max_uses)
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_cents int not null check (price_cents > 0),
  visits_per_cycle int check (visits_per_cycle > 0),
  service_ids uuid[] not null check (cardinality(service_ids) > 0),
  product_discount_bps int not null default 0 check (product_discount_bps between 0 and 10000),
  benefits text[] not null default '{}',
  active boolean not null default true
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id),
  plan_id uuid not null references plans (id),
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelled')),
  started_at timestamptz not null default now(),
  period_start date not null,
  period_end date not null,
  used_visits int not null default 0 check (used_visits >= 0),
  auto_renew boolean not null default true,
  cancelled_at timestamptz,
  check (period_end > period_start)
);
create unique index one_live_subscription on subscriptions (client_id) where status <> 'cancelled';

create table subscription_charges (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions (id),
  period_start date not null,
  period_end date not null,
  amount_cents int not null check (amount_cents > 0),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'void')),
  paid_at timestamptz,
  method payment_method,
  fee_cents int not null default 0,
  commission_closed boolean not null default false,
  -- Renovação rodando duas vezes não gera cobrança em dobro.
  unique (subscription_id, period_start)
);

create table sales (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients (id),
  barber_id uuid not null references barbers (id),
  appointment_id uuid unique references appointments (id),
  subtotal_cents int not null check (subtotal_cents >= 0),
  discount_cents int not null check (discount_cents >= 0),
  total_cents int not null check (total_cents >= 0),
  coupon_id uuid references coupons (id),
  subscription_id uuid references subscriptions (id),
  used_reward boolean not null default false,
  stamp_awarded boolean not null default false,
  reward_earned boolean not null default false,
  status text not null default 'paid' check (status in ('paid', 'refunded')),
  at timestamptz not null default now(),
  refunded_at timestamptz,
  refund_reason text not null default '',
  check (subtotal_cents - discount_cents = total_cents),
  check ((status = 'refunded') = (refunded_at is not null))
);
create index sales_at on sales (at);
alter table appointments add constraint appointments_sale foreign key (sale_id) references sales (id);

create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id),
  kind text not null check (kind in ('service', 'product')),
  ref_id uuid not null,
  name text not null,
  qty int not null check (qty > 0),
  unit_price_cents int not null check (unit_price_cents >= 0),
  gross_cents int not null,
  discount_cents int not null check (discount_cents >= 0),
  net_cents int not null check (net_cents >= 0),
  unit_cost_cents int not null default 0,
  barber_id uuid not null references barbers (id),
  coverage text check (coverage in ('subscription', 'reward')),
  check (gross_cents - discount_cents = net_cents)
);

create table sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales (id),
  method payment_method not null,
  amount_cents int not null check (amount_cents > 0),
  fee_cents int not null default 0 check (fee_cents >= 0)
);

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id),
  type text not null check (type in ('in', 'out', 'sale', 'refund', 'adjust')),
  qty int not null check (qty <> 0),
  unit_cost_cents int not null,
  at timestamptz not null default now(),
  sale_id uuid references sales (id),
  note text not null default ''
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('in', 'out')),
  category text not null,
  amount_cents int not null check (amount_cents > 0),
  method payment_method not null,
  at timestamptz not null default now(),
  description text not null,
  sale_id uuid references sales (id),
  reversal_of uuid unique references transactions (id),
  reversed boolean not null default false
);
create index transactions_at on transactions (at);

create table payouts (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references barbers (id),
  amount_cents int not null check (amount_cents > 0),
  method payment_method not null,
  at timestamptz not null default now()
);

create table commissions (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references barbers (id),
  sale_id uuid references sales (id),
  charge_id uuid references subscription_charges (id),
  kind text not null check (kind in ('service', 'product', 'subscription', 'reversal')),
  base_cents int not null,
  bps int not null,
  amount_cents int not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  payout_id uuid references payouts (id),
  at timestamptz not null default now(),
  check ((status = 'paid') = (payout_id is not null)),
  check (kind = 'reversal' or amount_cents >= 0)
);
create index commissions_barber on commissions (barber_id, status);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  audience text not null,
  subject text not null,
  body text not null,
  coupon_id uuid references coupons (id),
  recipients int not null,
  sent_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'email' check (channel in ('email', 'push')),
  recipient text not null,
  client_id uuid references clients (id),
  kind text not null,
  subject text not null,
  body text not null,
  -- Lembrete ou cobrança nunca sai em dobro, mesmo com a rotina rodando duas vezes.
  dedupe_key text not null unique,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);
create index messages_queue on messages (status, created_at);

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  entity_id uuid,
  detail text not null default ''
);

/* Histórico financeiro é imutável: correção é sempre um lançamento oposto. */

create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% é um histórico imutável', tg_table_name using errcode = 'P0001';
end $$;

create trigger immutable_stock before update or delete on stock_movements for each row execute function forbid_change();
create trigger immutable_payouts before update or delete on payouts for each row execute function forbid_change();
create trigger immutable_audit before update or delete on audit_log for each row execute function forbid_change();
create trigger immutable_items before update or delete on sale_items for each row execute function forbid_change();
create trigger immutable_payments before update or delete on sale_payments for each row execute function forbid_change();
create trigger keep_sales before delete on sales for each row execute function forbid_change();
create trigger keep_commissions before delete on commissions for each row execute function forbid_change();

create function guard_transaction() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'lançamentos não podem ser apagados' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - 'reversed') is distinct from (to_jsonb(old) - 'reversed') then
    raise exception 'lançamentos não podem ser alterados' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger guard_transactions before update or delete on transactions for each row execute function guard_transaction();

/* Permissões: dono vê tudo; barbeiro vê a própria operação; visitante não acessa tabela nenhuma. */

create function is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid() and role = 'owner')
$$;

create function my_barber() returns uuid language sql stable security definer set search_path = public as $$
  select barber_id from profiles where user_id = auth.uid()
$$;

create function is_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where user_id = auth.uid())
$$;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy owner_all on %I for all to authenticated using (is_owner()) with check (is_owner())', t);
  end loop;
end $$;

-- Catálogo e clientes: toda a equipe consulta.
create policy staff_read on settings for select to authenticated using (is_staff());
create policy staff_read on barbers for select to authenticated using (is_staff());
create policy staff_read on services for select to authenticated using (is_staff());
create policy staff_read on products for select to authenticated using (is_staff());
create policy staff_read on plans for select to authenticated using (is_staff());
create policy staff_read on subscriptions for select to authenticated using (is_staff());
create policy staff_read on clients for select to authenticated using (is_staff());
create policy staff_write on clients for insert to authenticated with check (is_staff());
create policy staff_update on clients for update to authenticated using (is_staff()) with check (is_staff());
create policy own_profile on profiles for select to authenticated using (user_id = auth.uid());

-- A agenda é visível para a equipe, mas cada barbeiro só altera a sua.
create policy staff_read on appointments for select to authenticated using (is_staff());
create policy own_insert on appointments for insert to authenticated with check (barber_id = my_barber());
create policy own_update on appointments for update to authenticated using (barber_id = my_barber()) with check (barber_id = my_barber());
create policy staff_read on blocks for select to authenticated using (is_staff());
create policy own_write on blocks for insert to authenticated with check (barber_id = my_barber());
create policy own_delete on blocks for delete to authenticated using (barber_id = my_barber());

-- Dinheiro: o barbeiro enxerga só o que é dele.
create policy own_commissions on commissions for select to authenticated using (barber_id = my_barber());
create policy own_payouts on payouts for select to authenticated using (barber_id = my_barber());
create policy own_sales on sales for select to authenticated using (barber_id = my_barber());
