-- Guard delivered shipment v2. No backfill, schema or post_doc changes.
create or replace function unpost_doc(p_company uuid, p_doc text)
returns void language plpgsql as $$
declare
  d docs%rowtype;
  m record;
  initial_order_id text;
  initial_type text;
  source_order orders%rowtype;
  delivery order_lifecycle_commands%rowtype;
  has_delivery boolean := false;
  delivery_matches integer := 0;
  shipment_payload jsonb;
  linkage_valid boolean;

begin
  perform set_config('app.ledger', '1', true);

  -- Read identity without a document lock. Every linked operation locks the
  -- order before any document/balance lock, then revalidates that identity.
  select * into d from docs
   where company_id = p_company and id = p_doc;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  initial_order_id := d.order_id;
  initial_type := d.doc_type;

  if d.order_id is not null and d.doc_type in
       ('retail_receipt','sales_shipment','retail_return','sales_return') then
    -- A tuple write is also a serialization fence for REPEATABLE READ /
    -- SERIALIZABLE snapshots. A plain FOR UPDATE alone leaves stale snapshots
    -- able to miss a newly committed return. Business values remain unchanged;
    -- the ordinary orders row-version trigger runs only on successful commits.
    update orders set id = id
     where company_id = p_company and id = initial_order_id
     returning * into source_order;
    if not found then
      raise exception 'Не найден исходный заказ продажи' using errcode = 'P0011';
    end if;
  end if;

  select * into d from docs
   where company_id = p_company and id = p_doc for update;
  if not found then
    raise exception 'Документ % не найден', p_doc using errcode = 'P0002';
  end if;
  if d.order_id is distinct from initial_order_id or d.doc_type is distinct from initial_type then
    raise exception 'Связь документа с исходной продажей изменилась; повторите запрос' using errcode = 'P0011';
  end if;
  if d.status <> 'posted' then
    raise exception 'Документ % не проведён', p_doc using errcode = 'P0008';
  end if;

  if d.doc_type in ('retail_receipt','sales_shipment') and d.order_id is not null and exists (
    select 1 from docs r
     where r.company_id = p_company and r.order_id = d.order_id
       and r.doc_type in ('retail_return','sales_return')
       and (r.status = 'posted'
         or exists (select 1 from stock_movements stock_return where stock_return.company_id = p_company and stock_return.doc_id = r.id)
         or exists (select 1 from money_movements money_return where money_return.company_id = p_company and money_return.doc_id = r.id)
         or exists (select 1 from settlement_movements settlement_return where settlement_return.company_id = p_company and settlement_return.doc_id = r.id))
  ) then
    -- Do not ignore a posted return merely because it was soft-deleted.
    raise exception 'Продажа имеет проведённые возвраты; отмена запрещена' using errcode = 'P0010';
  end if;

  -- Delivery is irreversible through unpost. Check after P0010, before any
  -- accounting mutation. The existing order write fence serializes this read
  -- with delivery/returns, including old RR/SERIALIZABLE snapshots (40001).
  if d.doc_type in ('retail_receipt','sales_shipment') then
    -- Also find the receipt by its immutable shipment identity: a damaged
    -- order_id must not detach a delivered document from its protection.
    select count(*) into delivery_matches from order_lifecycle_commands
     where company_id = p_company and operation = 'delivered'
       and (order_id = d.order_id or command_id = 'delivered:' || substring(d.id from 10));
    select * into delivery from order_lifecycle_commands
     where company_id = p_company and operation = 'delivered'
       and (order_id = d.order_id or command_id = 'delivered:' || substring(d.id from 10))
     order by command_id limit 1;
    has_delivery := found;

    -- source_payload historically contains arbitrary text. Invalid/oversized
    -- JSON is missing evidence, never permission to unpost a protected delivery.
    if d.source_payload is not null and octet_length(d.source_payload) <= 262144 then
      begin
        shipment_payload := d.source_payload::jsonb;
      exception when data_exception then
        shipment_payload := null;
      end;
    end if;

    if (source_order.status = 'delivered' or has_delivery)
       and (source_order.commercial_snapshot is not null or has_delivery
            or shipment_payload->>'kind' = 'shipment-v2') then
      linkage_valid := (
        source_order.commercial_snapshot is not null
        and d.doc_type = 'sales_shipment'
        and source_order.shipment_doc_id = d.id
        and shipment_payload->>'kind' = 'shipment-v2'
        and shipment_payload#>>'{request,companyId}' = p_company::text
        and shipment_payload#>>'{request,orderId}' = d.order_id
        and shipment_payload#>>'{request,contractVersion}' = '2'
        and shipment_payload#>>'{request,status}' = 'shipped'
        and shipment_payload#>>'{request,warehouseId}' = d.warehouse_id
        and shipment_payload#>>'{request,shipmentId}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and d.id = 'shipment-' || (shipment_payload#>>'{request,shipmentId}')
        and shipment_payload#>'{request,orderSnapshot}' = source_order.commercial_snapshot
        and shipment_payload->>'fingerprint' ~ '^[0-9a-f]{64}$'
        and shipment_payload#>>'{result,fingerprint}' = shipment_payload->>'fingerprint'
        and shipment_payload#>>'{result,documentId}' = d.id
        and shipment_payload#>>'{result,shipmentId}' = shipment_payload#>>'{request,shipmentId}'
        and shipment_payload#>>'{result,warehouseId}' = d.warehouse_id
        and shipment_payload#>>'{result,order,id}' = d.order_id
      );
      if has_delivery then
        linkage_valid := linkage_valid and (
          delivery_matches = 1
          and delivery.order_id = d.order_id
          and delivery.command_id = 'delivered:' || (shipment_payload#>>'{request,shipmentId}')
          and delivery.response_status = 200
          and delivery.canonical_payload->>'companyId' = p_company::text
          and delivery.canonical_payload->>'orderId' = d.order_id
          and delivery.canonical_payload->>'contractVersion' = '2'
          and delivery.canonical_payload->>'status' = 'delivered'
          and delivery.canonical_payload->>'shipmentId' = shipment_payload#>>'{request,shipmentId}'
          and delivery.canonical_payload->>'shipmentFingerprint' = shipment_payload->>'fingerprint'
          and delivery.response_body->>'ok' = 'true'
          and delivery.response_body->>'contractVersion' = '2'
          and delivery.response_body->>'commandId' = delivery.command_id
          and delivery.response_body->>'documentId' = d.id
          and delivery.response_body->>'shipmentId' = shipment_payload#>>'{request,shipmentId}'
          and delivery.response_body#>>'{order,id}' = d.order_id
          and delivery.response_body#>>'{order,status}' = 'delivered'
          and delivery.response_body->>'fingerprint' = delivery.fingerprint
        );
      end if;
      if linkage_valid is not true then
        raise exception 'Связь доставленной защищённой отгрузки повреждена; требуется сверка'
          using errcode = 'P0013';
      end if;
      raise exception 'Доставленный защищённый заказ нельзя распровести; оформите возврат'
        using errcode = 'P0012';
    end if;
  end if;

  for m in
    select * from stock_movements
     where company_id = p_company and doc_id = p_doc
     order by qty asc
  loop
    perform apply_stock(p_company, m.warehouse_id, m.product_id, -m.qty,
                        case when m.qty < 0 then -m.cost_amount else null end,
                        true);
    perform sync_product_mirror(p_company, m.product_id);
  end loop;

  delete from stock_movements where company_id = p_company and doc_id = p_doc;
  delete from money_movements where company_id = p_company and doc_id = p_doc;
  delete from settlement_movements where company_id = p_company and doc_id = p_doc;

  if d.party_id is not null then
    perform sync_party_mirror(p_company, d.party_kind, d.party_id);
  end if;

  update docs set status = 'draft', posted_at = null
   where company_id = p_company and id = p_doc;
end $$;
