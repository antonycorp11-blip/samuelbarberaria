-- Fila de envio para Gmail: teto diário, prioridade e reserva atômica.

alter table messages
  add column attempts int not null default 0,
  add column claimed_at timestamptz;

create function is_marketing(p_kind text) returns boolean language sql immutable as $$
  select p_kind in ('birthday', 'recovery', 'campaign')
$$;

/*
 * Entrega o próximo lote já reservado como 'sending'.
 * Lembretes e confirmações vêm primeiro; marketing só usa o que sobra até o próprio teto,
 * para uma campanha grande nunca consumir o limite do Gmail e travar os lembretes.
 * O dia é o de São Paulo. Push não conta: não passa pelo Gmail.
 */
create function claim_messages(p_daily_cap int, p_marketing_cap int, p_batch int)
returns setof messages language plpgsql as $$
declare
  v_day timestamptz := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  v_left int;
  v_marketing_left int;
  v_ids uuid[];
  v_extra uuid[];
begin
  -- Duas execuções simultâneas contam e reservam uma de cada vez.
  perform pg_advisory_xact_lock(hashtext('claim_messages'));

  -- Lembrete atrasado mais de um dia já não ajuda ninguém.
  update messages set status = 'failed', error = 'expirada'
  where status = 'queued' and kind in ('reminder_24h', 'reminder_2h') and created_at < now() - interval '1 day';

  -- Execução que caiu no meio devolve o que tinha reservado.
  update messages set status = 'queued', claimed_at = null
  where status = 'sending' and claimed_at < now() - interval '15 minutes';

  select
    greatest(p_daily_cap - count(*), 0),
    greatest(p_marketing_cap - count(*) filter (where is_marketing(kind)), 0)
  into v_left, v_marketing_left
  from messages
  where channel = 'email' and status in ('sent', 'sending') and coalesce(sent_at, claimed_at) >= v_day;

  select coalesce(array_agg(id), '{}') into v_ids from (
    select id from messages where status = 'queued' and channel = 'push' order by created_at limit p_batch
  ) m;

  select coalesce(array_agg(id), '{}') into v_extra from (
    select id from messages where status = 'queued' and channel = 'email' and not is_marketing(kind)
    order by created_at limit least(v_left, greatest(p_batch - cardinality(v_ids), 0))
  ) m;
  v_ids := v_ids || v_extra;
  v_left := v_left - cardinality(v_extra);

  select coalesce(array_agg(id), '{}') into v_extra from (
    select id from messages where status = 'queued' and channel = 'email' and is_marketing(kind)
    order by created_at limit least(v_left, v_marketing_left, greatest(p_batch - cardinality(v_ids), 0))
  ) m;
  v_ids := v_ids || v_extra;

  return query
    update messages set status = 'sending', claimed_at = now()
    where id = any (v_ids)
    returning *;
end $$;

/* Única limpeza automática do sistema. Dados financeiros e de clientes nunca entram aqui. */
create function purge_old_messages(p_days int default 90) returns int language plpgsql as $$
declare v_count int;
begin
  delete from messages where status in ('sent', 'failed') and created_at < now() - make_interval(days => p_days);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function claim_messages(int, int, int) from public, anon, authenticated;
revoke execute on function purge_old_messages(int) from public, anon, authenticated;
grant execute on function claim_messages(int, int, int) to service_role;
grant execute on function purge_old_messages(int) to service_role;
