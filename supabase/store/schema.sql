-- Banco da Samuel Barbearia, isolado no schema `barbearia`.
-- Nenhuma tabela é exposta: o acesso é só pelas funções barbearia_* com a chave do servidor.
-- Assim dá para hospedar no mesmo projeto de outro sistema sem encostar nele.

create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema barbearia;
revoke all on schema barbearia from public, anon, authenticated;

create table barbearia.meta (
  id boolean primary key default true check (id),
  version bigint not null default 0,
  -- Só o hash: a chave em si existe apenas como segredo na Cloudflare.
  api_secret_hash text not null
);

-- Cada registro do app é uma linha. `version` permite baixar só o que mudou.
create table barbearia.entities (
  collection text not null,
  id text not null,
  data jsonb not null,
  version bigint not null,
  deleted boolean not null default false,
  primary key (collection, id),
  -- A última barreira, valendo mesmo se o app tiver um bug.
  constraint stock_not_negative check (collection <> 'products' or deleted or (data->>'qty')::int >= 0),
  constraint sale_totals check (
    collection <> 'sales' or (data->>'subtotalCents')::int - (data->>'discountCents')::int = (data->>'totalCents')::int
  ),
  constraint positive_transaction check (collection <> 'transactions' or (data->>'amountCents')::int > 0)
);
create index entities_version on barbearia.entities (version);

create function barbearia.appointment_range(d jsonb) returns tstzrange
language sql immutable as $$ select tstzrange((d->>'start')::timestamptz, (d->>'end')::timestamptz) $$;

alter table barbearia.entities add constraint no_double_booking exclude using gist (
  (data->>'barberId') extensions.gist_text_ops with =,
  barbearia.appointment_range(data) with &&
) where (
  collection = 'appointments' and not deleted
  and data->>'status' in ('scheduled', 'confirmed', 'in_progress', 'completed')
);

create unique index one_sale_per_appointment on barbearia.entities ((data->>'appointmentId'))
  where collection = 'sales' and data->>'appointmentId' is not null;
create unique index message_dedupe on barbearia.entities ((data->>'dedupeKey')) where collection = 'messages';

/* Histórico financeiro: correção é sempre um lançamento oposto. */
create function barbearia.guard_history() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.deleted then
    if old.collection in ('transactions', 'sales', 'commissions', 'payouts', 'stockMovements', 'audit') then
      raise exception '% não pode ser apagado', old.collection using errcode = 'P0001';
    end if;
    return coalesce(new, old);
  end if;
  if old.collection in ('payouts', 'stockMovements', 'audit') and new.data is distinct from old.data then
    raise exception '% é um histórico imutável', old.collection using errcode = 'P0001';
  end if;
  if old.collection = 'transactions' and (new.data - 'reversed') is distinct from (old.data - 'reversed') then
    raise exception 'lançamentos não podem ser alterados' using errcode = 'P0001';
  end if;
  if old.collection = 'sales'
    and (new.data - array['status', 'refundedAt', 'refundReason']) is distinct from (old.data - array['status', 'refundedAt', 'refundReason']) then
    raise exception 'vendas não podem ser alteradas, só estornadas' using errcode = 'P0001';
  end if;
  if old.collection = 'commissions'
    and (new.data - array['status', 'payoutId']) is distinct from (old.data - array['status', 'payoutId']) then
    raise exception 'comissões não podem ser alteradas' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger guard_history before update or delete on barbearia.entities
  for each row execute function barbearia.guard_history();

create table barbearia.staff (
  email text primary key check (email = lower(email)),
  password_hash text not null,
  role text not null check (role in ('owner', 'barber')),
  barber_id text,
  name text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  check (role = 'owner' or barber_id is not null)
);

create function barbearia.check_secret(p_secret text) returns void language plpgsql as $$
begin
  if p_secret is null or not exists (
    select 1 from barbearia.meta where api_secret_hash = encode(extensions.digest(p_secret, 'sha256'), 'hex')
  ) then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
end $$;

/* Portas de entrada. */

create function public.barbearia_pull(p_secret text, p_since bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform barbearia.check_secret(p_secret);
  return jsonb_build_object(
    'version', (select version from barbearia.meta),
    'changes', coalesce((
      select jsonb_agg(jsonb_build_object('c', collection, 'id', id, 'data', case when deleted then null else data end))
      from barbearia.entities where version > p_since
    ), '[]'::jsonb)
  );
end $$;

-- Grava tudo ou nada. Se outro comando entrou antes, devolve conflito e o servidor refaz.
create function public.barbearia_push(p_secret text, p_expected bigint, p_changes jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_version bigint;
  v_change jsonb;
begin
  perform barbearia.check_secret(p_secret);
  select version into v_version from barbearia.meta for update;
  if v_version <> p_expected then
    raise exception 'conflito de versão' using errcode = '40001';
  end if;
  v_version := v_version + 1;
  for v_change in select * from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(v_change->'data') = 'null' or v_change->'data' is null then
      update barbearia.entities set deleted = true, version = v_version
      where collection = v_change->>'c' and id = v_change->>'id';
    else
      insert into barbearia.entities (collection, id, data, version)
      values (v_change->>'c', v_change->>'id', v_change->'data', v_version)
      on conflict (collection, id) do update set data = excluded.data, version = excluded.version, deleted = false;
    end if;
  end loop;
  -- O Supabase recusa UPDATE sem WHERE nas chamadas da API.
  update barbearia.meta set version = v_version where id;
  return v_version;
end $$;

create function public.barbearia_staff_count(p_secret text)
returns int language plpgsql security definer set search_path = '' as $$
begin
  perform barbearia.check_secret(p_secret);
  return (select count(*) from barbearia.staff);
end $$;

create function public.barbearia_set_staff(p_secret text, p_email text, p_password text, p_role text, p_barber_id text, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform barbearia.check_secret(p_secret);
  if length(p_password) < 8 then
    raise exception 'A senha precisa ter ao menos 8 caracteres.' using errcode = 'P0001';
  end if;
  insert into barbearia.staff (email, password_hash, role, barber_id, name)
  values (lower(trim(p_email)), extensions.crypt(p_password, extensions.gen_salt('bf', 10)), p_role, p_barber_id, p_name)
  on conflict (email) do update set
    password_hash = excluded.password_hash, role = excluded.role, barber_id = excluded.barber_id,
    name = excluded.name, failed_attempts = 0, locked_until = null;
end $$;

-- A conferência da senha fica no banco: o erro de login só diz "e-mail ou senha", e 5 erros travam por 15 minutos.
create function public.barbearia_login(p_secret text, p_email text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v barbearia.staff;
begin
  perform barbearia.check_secret(p_secret);
  select * into v from barbearia.staff where email = lower(trim(p_email));
  if not found then
    return null;
  end if;
  if v.locked_until > now() then
    return jsonb_build_object('locked', true);
  end if;
  if v.password_hash <> extensions.crypt(p_password, v.password_hash) then
    update barbearia.staff set
      failed_attempts = case when failed_attempts >= 4 then 0 else failed_attempts + 1 end,
      locked_until = case when failed_attempts >= 4 then now() + interval '15 minutes' else null end
    where email = v.email;
    return null;
  end if;
  update barbearia.staff set failed_attempts = 0, locked_until = null where email = v.email;
  return jsonb_build_object('role', v.role, 'barberId', v.barber_id, 'name', v.name, 'email', v.email);
end $$;

create function public.barbearia_staff_info(p_secret text, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform barbearia.check_secret(p_secret);
  return (select jsonb_build_object('role', role, 'name', name) from barbearia.staff where email = lower(trim(p_email)));
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'barbearia_pull(text, bigint)', 'barbearia_push(text, bigint, jsonb)', 'barbearia_staff_count(text)',
    'barbearia_set_staff(text, text, text, text, text, text)', 'barbearia_login(text, text, text)', 'barbearia_staff_info(text, text)'
  ] loop
    execute format('revoke execute on function public.%s from public, authenticated', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;
