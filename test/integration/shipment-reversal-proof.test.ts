import { randomUUID } from 'node:crypto'
import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { reconcileStock,STOCK_RECONCILE_LIMITS } from '../../src/services/stockReconcile.js'
import type { StockReconcileInput } from '../../src/routes/stock.js'
import { cancellationV2 } from '../../src/services/cancellationsV2.js'
import { saleFingerprint } from '../../src/services/salesV2.js'
import { allowSkipIntegration,call,cancelShipmentV2,hasDb,setupIntegration,type Ctx } from './helpers.js'
if(!hasDb&&!allowSkipIntegration)throw Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('shipment v2 reversal proof — read-only PostgreSQL',()=>{
 let ctx:Ctx
 beforeEach(async()=>{ctx=await setupIntegration()})
 afterEach(async()=>{if(!ctx)return;try{
  expect((await ctx.pool.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks).toBe('0')
  expect((await ctx.pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and (state='idle in transaction' or wait_event_type='Lock')")).rows[0].n).toBe(0)
 }finally{await ctx.close()}})
 const snapshot = () => ({ items: [{ lineId: 'source-z', productId: 'p1', unitId: 'u-sht', unitFactor: '1', qtyInput: '2', qtyBase: '2', price: '50.00' }],
  customerId: 'c1', customerName: 'Customer', no: null, priceTypeId: null, shiftId: null, subtotal: '100.00', discount: { kind: 'percent', value: '0' },
  total: '100.00', rounding: 'kopeck', onCredit: true, creditTerms: null, payment: { method: 'credit', cashPaid: '0', cardPaid: '0', change: '0' },
  vatSummary: null, address: 'Address', geo: null, courier: null, assignedTo: null, priority: false })
 const fixture = (warehouseId = 'w1') => ({ orderId: randomUUID(), payload: {
  contractVersion: 2, status: 'shipped', shipmentId: randomUUID(), warehouseId, orderSnapshot: snapshot(),
 } })
 type Fixture = ReturnType<typeof fixture>
 async function prepare(f: Fixture) {
  expect((await call(ctx, 'POST', '/v1/orders', { contractVersion: 2, commandId: randomUUID(), orderId: f.orderId, commercial: f.payload.orderSnapshot })).statusCode).toBe(201)
  for (const status of ['confirmed', 'packed']) expect((await call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, { status })).statusCode).toBe(200)
 }
 const post = (f: Fixture) => call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, f.payload, `shipment:${f.payload.shipmentId}`)
 const deliver = async (f: Fixture) => {
  const saved = JSON.parse((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2',[ctx.companyId,`shipment-${f.payload.shipmentId}`])).rows[0].source_payload)
  return call(ctx,'POST',`/v1/orders/${f.orderId}/status`,{contractVersion:2,status:'delivered',shipmentId:f.payload.shipmentId,shipmentFingerprint:saved.fingerprint},`delivered:${f.payload.shipmentId}`)
 }
 const request = (f: Fixture): StockReconcileInput => ({ contractVersion: 1, requestId: randomUUID(), productIds: ['p1'],
  commands: [{ commandId: f.orderId, kind: 'order_status', idempotencyKey: `shipment:${f.payload.shipmentId}`, payload: f.payload }] })
 const reconcile = async (f: Fixture) => {
  const response = await call(ctx, 'POST', '/v1/stock/reconcile', request(f))
  expect(response.statusCode).toBe(200)
  return response.json()
 }
 async function seed() {
  for (const [warehouseId, qty] of [['w1', 40], ['w2', 60]] as const) expect((await call(ctx, 'POST', '/v1/documents/post', {
   document: { id: randomUUID(), type: 'receive', warehouseId, items: [{ productId: 'p1', qty, cost: 7 }] },
  })).statusCode).toBe(201)
 }
 async function facts() {
  const result: Record<string, unknown> = {}
  for (const table of ['docs', 'doc_lines', 'orders', 'order_commercial_commands', 'stock_balances', 'stock_movements', 'money_movements', 'settlement_movements', 'customers', 'idempotency_keys', 'audit', 'order_lifecycle_commands', 'customer_financial_fences']) {
   result[table] = (await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as rows from ${table} t where company_id=$1`, [ctx.companyId])).rows[0].rows
  }
  return result
 }
 async function editProof(f: Fixture, edit: (saved: any) => any) {
  const id = `shipment-${f.payload.shipmentId}`
  const saved = JSON.parse((await ctx.pool.query('select source_payload from docs where company_id=$1 and id=$2', [ctx.companyId, id])).rows[0].source_payload)
  await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2', [ctx.companyId, id, JSON.stringify(edit(saved))])
 }
 async function ledgerWrite(sql: string, params: unknown[]) {
  const client = await ctx.pool.connect()
  try {
   await client.query('begin'); await client.query("select set_config('app.ledger','1',true)"); await client.query(sql, params); await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
 }

 async function posted(warehouse='w1'){await seed();const f=fixture(warehouse);await prepare(f);expect((await post(f)).statusCode).toBe(200);return f}
 async function cancelled(warehouse='w1'){const f=await posted(warehouse),r=await cancelShipmentV2(ctx,f.orderId,f.payload);expect(r.statusCode,r.body).toBe(200);return f}
 const docId=(f:Fixture)=>`shipment-${f.payload.shipmentId}`
 async function expected(f:Fixture,resolution:string,reason?:string){const before=await facts(),r=await reconcile(f);expect(r.commands[0]).toMatchObject({resolution,effectIncluded:resolution==='reversed'?false:resolution==='applied'?true:resolution==='not_observed'?false:null,...(reason?{reason}:{})});expect(await facts()).toEqual(before);return r}
 async function receipt(f:Fixture){return (await ctx.pool.query("select * from order_lifecycle_commands where company_id=$1 and command_id=$2",[ctx.companyId,`cancelled:${f.payload.shipmentId}`])).rows[0]}
 async function editReceipt(f:Fixture,edit:(r:any)=>void){const r=await receipt(f);edit(r);await ctx.pool.query('update order_lifecycle_commands set command_id=$3,canonical_payload=$4::jsonb,fingerprint=$5,response_body=$6::jsonb where company_id=$1 and command_id=$2',[ctx.companyId,`cancelled:${f.payload.shipmentId}`,r.command_id,JSON.stringify(r.canonical_payload),r.fingerprint,JSON.stringify(r.response_body)])}
 const cancelCommand=(f:Fixture) => ({kind:'order_cancel' as const,commandId:`cancelled:${f.payload.shipmentId}`,orderId:f.orderId,idempotencyKey:`cancelled:${f.payload.shipmentId}`,payload:{contractVersion:2 as const,status:'cancelled' as const,shipmentId:f.payload.shipmentId,shipmentFingerprint:saleFingerprint({companyId:ctx.companyId,orderId:f.orderId,...f.payload})}})
 const cancelRequest=(f:Fixture):StockReconcileInput=>({...request(f),commands:[cancelCommand(f)]})
 async function cancelExpected(f:Fixture,resolution:string){const before=await facts(),r=await call(ctx,'POST','/v1/stock/reconcile',cancelRequest(f));expect(r.statusCode,r.body).toBe(200);expect(r.json().commands[0].resolution).toBe(resolution);expect(await facts()).toEqual(before);return r.json()}
 it('order_cancel applied and shipment reversed share one snapshot, replay survives temporary key deletion',async()=>{
  const f=await cancelled(),b=request(f);b.commands.push(cancelCommand(f));const before=await facts()
  for(let i=0;i<2;i++){const r=await call(ctx,'POST','/v1/stock/reconcile',b);expect(r.statusCode,r.body).toBe(200);expect(r.json().commands.map((c:any)=>c.resolution)).toEqual(['reversed','applied']);expect(r.json().totals[0].qtyBase).toBe('100.0000')}
  expect(await facts()).toEqual(before);await ctx.pool.query('delete from idempotency_keys where company_id=$1',[ctx.companyId]);await cancelExpected(f,'applied')
 })
 it.each(['same-id','missing-order','bad-key','bad-command','bad-uuid','bad-fingerprint','body-order','legacy-order'])('strict cancel validator rejects %s',async kind=>{
  const f=await posted(),b:any=cancelRequest(f),c=b.commands[0]
  if(kind==='same-id')b.commands.push({kind:'doc_post',commandId:c.commandId,idempotencyKey:'another',payload:{}})
  if(kind==='missing-order')delete c.orderId
  if(kind==='bad-key')c.idempotencyKey='wrong'
  if(kind==='bad-command')c.commandId='wrong'
  if(kind==='bad-uuid')c.payload.shipmentId='wrong'
  if(kind==='bad-fingerprint')c.payload.shipmentFingerprint='wrong'
  if(kind==='body-order')c.payload.orderId=f.orderId
  if(kind==='legacy-order')b.commands=[{...request(f).commands[0],orderId:f.orderId}]
  expect((await call(ctx,'POST','/v1/stock/reconcile',b)).statusCode).toBe(400)
 })
 it.each(['order','shipment','fingerprint'])('cancel request mismatched %s is conflict',async kind=>{
  const f=await cancelled(),b=cancelRequest(f),c=b.commands[0] as any
  if(kind==='order')c.orderId=randomUUID()
  if(kind==='shipment'){c.payload.shipmentId=randomUUID();c.commandId=c.idempotencyKey=`cancelled:${c.payload.shipmentId}`}
  if(kind==='fingerprint')c.payload.shipmentFingerprint='0'.repeat(64)
  const r=await call(ctx,'POST','/v1/stock/reconcile',b);expect(r.statusCode,r.body).toBe(200);expect(r.json().commands[0].resolution).toBe('conflict')
 })
 it.each(['canonical','fingerprint','document','body'])('cancel damaged receipt %s cannot confirm',async kind=>{
  const f=await cancelled();await editReceipt(f,r=>{if(kind==='canonical')r.canonical_payload.shipmentFingerprint='0'.repeat(64);if(kind==='fingerprint')r.fingerprint='0'.repeat(64);if(kind==='document')r.response_body.documentId='wrong';if(kind==='body')r.response_body.ok=false});await cancelExpected(f,'unverifiable')
 })
 it('discarded committed HTTP result is reconciled without a second cancellation',async()=>{
  const f=await posted()
  // Commit the request but deliberately discard the HTTP response, as a disconnected client would.
  await call(ctx,'POST',`/v1/orders/${f.orderId}/status`,cancelCommand(f).payload,cancelCommand(f).idempotencyKey)
  const before=await facts();await cancelExpected(f,'applied');await cancelExpected(f,'applied');expect(await facts()).toEqual(before)
 })
 it('cancel read issues only read-only SQL and retains not_observed without executing a retry',async()=>{
  const f=await posted(),before=await facts(),c=await ctx.pool.connect(),log:string[]=[]
  const query=async(sql:string,values?:unknown[])=>{log.push(sql);return c.query(sql,values)}
  try{const r=await reconcileStock({...ctx.pool,connect:async()=>({query,release:()=>{}})} as any,ctx.companyId,cancelRequest(f));expect(r.commands[0]!.resolution).toBe('not_observed');expect(log.some(sql=>/\b(insert|update|delete)\b|for share|pg_advisory|unpost_doc|post_doc/i.test(sql))).toBe(false);expect(await facts()).toEqual(before)}finally{c.release()}
 })
 it('missing receipt is unknown after cancellation, but unobserved before cancellation',async()=>{
  const f=await posted();await cancelExpected(f,'not_observed');expect((await cancelShipmentV2(ctx,f.orderId,f.payload)).statusCode).toBe(200);await ctx.pool.query("delete from order_lifecycle_commands where company_id=$1 and operation='cancelled'",[ctx.companyId]);await cancelExpected(f,'unverifiable')
 })
 it.each(['movement','balance','archive'])('cancel %s validates the same reversal facts',async kind=>{
  const f=await cancelled()
  if(kind==='movement')await ctx.pool.query("insert into money_movements(company_id,id,doc_id,doc_type,account_id,amount) values($1,'left',$2,'payment_out','cash',-1)",[ctx.companyId,docId(f)])
  if(kind==='balance')await ctx.pool.query("update stock_balances set qty=999 where company_id=$1 and warehouse_id='w2'",[ctx.companyId])
  if(kind==='archive')await ctx.pool.query("update warehouses set deleted_at=now() where company_id=$1 and id='w2'",[ctx.companyId])
  await cancelExpected(f,kind==='archive'?'applied':'unverifiable')
 })
 it('cancel never uses another company receipt',async()=>{
  const f=await cancelled(),other=await setupIntegration()
  try{const r=await call(other,'POST','/v1/stock/reconcile',cancelRequest(f));expect(r.statusCode,r.body).toBe(200);expect(r.json().commands[0].resolution).toBe('not_observed')}finally{await other.close()}
 })
 it('cancel/reconcile sees a whole snapshot while commit occurs between reads',async()=>{
  const f=await posted(),c=await ctx.pool.connect();let committed=false
  const query=async(sql:string,values?:unknown[])=>{const r=await c.query(sql,values);if(sql.startsWith('select warehouse_id as')&&!committed){committed=true;expect((await cancelShipmentV2(ctx,f.orderId,f.payload)).statusCode).toBe(200)}return r}
  try{const before=await reconcileStock({...ctx.pool,connect:async()=>({query,release:()=>{}})} as any,ctx.companyId,cancelRequest(f));expect(before.commands[0]!.resolution).toBe('not_observed');expect(before.totals[0]!.qtyBase).toBe('98.0000');await cancelExpected(f,'applied')}finally{c.release()}
 })
 for(const warehouse of ['w1','w2'])it(`${warehouse}: applied before cancellation, reversed afterward, exact all-warehouse balances and no writes`,async()=>{
  const f=await posted(warehouse);expect((await expected(f,'applied')).totals).toEqual([{productId:'p1',qtyBase:'98.0000'}])
  expect((await cancelShipmentV2(ctx,f.orderId,f.payload)).statusCode).toBe(200)
  const r=await expected(f,'reversed','PERSISTENT_SHIPMENT_V2_CANCELLATION_PROOF');expect(r.totals).toEqual([{productId:'p1',qtyBase:'100.0000'}]);expect(r.balances).toEqual([{warehouseId:'w1',productId:'p1',qtyBase:'40.0000'},{warehouseId:'w2',productId:'p1',qtyBase:'60.0000'}])
 })
 it.each(['deleted-receipt','status-only','unpost-only'])('%s cannot manufacture reversal evidence',async kind=>{
  const f=kind==='deleted-receipt'?await cancelled():await posted()
  if(kind==='deleted-receipt')await ctx.pool.query("delete from order_lifecycle_commands where company_id=$1 and operation='cancelled'",[ctx.companyId])
  if(kind==='status-only')await ctx.pool.query("update orders set status='cancelled' where company_id=$1 and id=$2",[ctx.companyId,f.orderId])
  if(kind==='unpost-only')await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,docId(f)])
  await expected(f,'unverifiable')
 })
 it.each(['fingerprint','canonical','manifest','manifest-hash','source-hash','line-hash','removed-ids','restored-qty','removed-debt','command-id','version'])('damaged cancellation %s remains unverifiable',async kind=>{
  const f=await cancelled();await editReceipt(f,r=>{
   const b=r.response_body,e=b.evidence
   if(kind==='fingerprint')r.fingerprint='0'.repeat(64)
   if(kind==='canonical')r.canonical_payload={...r.canonical_payload,shipmentFingerprint:'0'.repeat(64)}
   if(kind==='manifest')e.manifest.stockMovements[0].qty='-999'
   if(kind==='manifest-hash')e.manifestHash='0'.repeat(64)
   if(kind==='source-hash')e.sourcePayloadHash='0'.repeat(64)
   if(kind==='line-hash')e.sourceLinesHash='0'.repeat(64)
   if(kind==='removed-ids')e.removed.stockIds=[]
   if(kind==='restored-qty')b.restoredItems[0].qtyBase='999'
   if(kind==='removed-debt')b.debtRemovedMinor='999'
   if(kind==='command-id')r.command_id='cancelled:wrong'
   if(kind==='version')e.version=2
  });await expected(f,'unverifiable','SHIPMENT_CANCELLATION_PROOF_INVALID')
 })
 it.each(['qty','cost','line-number','note','delete','deleted','raw-proof','marker','stock-flag','snapshot','status','extra-shipment'])('damaged current %s cannot reuse an old receipt as current proof',async kind=>{
  const f=await cancelled(),id=docId(f)
  if(kind==='qty')await ctx.pool.query('update doc_lines set qty=3 where company_id=$1 and doc_id=$2',[ctx.companyId,id])
  if(kind==='cost')await ctx.pool.query('update doc_lines set cost_amount=99 where company_id=$1 and doc_id=$2',[ctx.companyId,id])
  if(kind==='line-number')await ctx.pool.query('update doc_lines set line_no=99 where company_id=$1 and doc_id=$2',[ctx.companyId,id])
  if(kind==='note')await ctx.pool.query("update doc_lines set note='changed' where company_id=$1 and doc_id=$2",[ctx.companyId,id])
  if(kind==='delete')await ctx.pool.query('delete from doc_lines where company_id=$1 and doc_id=$2',[ctx.companyId,id])
  if(kind==='deleted')await ctx.pool.query('update doc_lines set deleted_at=now() where company_id=$1 and doc_id=$2',[ctx.companyId,id])
  if(kind==='raw-proof')await ctx.pool.query("update docs set source_payload=source_payload||' ' where company_id=$1 and id=$2",[ctx.companyId,id])
  if(kind==='marker')await ctx.pool.query('update orders set shipment_doc_id=null where company_id=$1 and id=$2',[ctx.companyId,f.orderId])
  if(kind==='stock-flag')await ctx.pool.query('update orders set stock_consumed=true where company_id=$1 and id=$2',[ctx.companyId,f.orderId])
  if(kind==='snapshot')await ctx.pool.query('update orders set commercial_snapshot=null where company_id=$1 and id=$2',[ctx.companyId,f.orderId])
  if(kind==='status')await ctx.pool.query("update orders set status='shipped' where company_id=$1 and id=$2",[ctx.companyId,f.orderId])
  if(kind==='extra-shipment')await ctx.pool.query("insert into docs(company_id,id,doc_type,order_id,warehouse_id) values($1,'extra','sales_shipment',$2,'w1')",[ctx.companyId,f.orderId])
  await expected(f,'unverifiable')
 })
 it('valid original proof with a different requested warehouse or composition is conflict',async()=>{
  const f=await cancelled();await expected({...f,payload:{...f.payload,warehouseId:'w2'}},'conflict')
  await expected({...f,payload:{...f.payload,orderSnapshot:{...f.payload.orderSnapshot,total:'150.00'}}},'conflict')
 })
 it('changed native warehouse is a proven identity conflict',async()=>{
  const f=await cancelled();await ctx.pool.query("update docs set warehouse_id='w2' where company_id=$1 and id=$2",[ctx.companyId,docId(f)]);await expected(f,'conflict')
 })
 it('does not call a re-posted shipment applied or reversed while a cancellation receipt exists',async()=>{
  const f=await cancelled();await ctx.pool.query("update orders set status='shipped',stock_consumed=true where company_id=$1 and id=$2",[ctx.companyId,f.orderId]);await ctx.pool.query("update docs set status='draft' where company_id=$1 and id=$2",[ctx.companyId,docId(f)]);await ctx.pool.query('select post_doc($1,$2)',[ctx.companyId,docId(f)])
  await expected(f,'unverifiable','SHIPMENT_REVERSAL_DOCUMENT_NOT_VOID')
 })
 it.each(['stock','moved-stock','money','settlement','moved-settlement'])('remaining %s blocks reversal, including deleted IDs moved to another document',async kind=>{
  const f=await cancelled(),m=(await receipt(f)).response_body.evidence.manifest,id=docId(f)
  if(kind==='stock'||kind==='moved-stock'){
   const row=m.stockMovements[0];await ctx.pool.query('insert into stock_movements(company_id,id,doc_id,doc_type,warehouse_id,product_id,qty,cost_amount) values($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.companyId,row.id,kind==='stock'?id:'another-doc',row.doc_type,row.warehouse_id,row.product_id,row.qty,row.cost_amount])
  }else if(kind==='money')await ctx.pool.query("insert into money_movements(company_id,id,doc_id,doc_type,account_id,amount) values($1,'leftover-money',$2,'payment_out','cash',-1)",[ctx.companyId,id])
  else{const row=m.settlementMovements[0];await ctx.pool.query('insert into settlement_movements(company_id,id,doc_id,doc_type,party_kind,party_id,amount) values($1,$2,$3,$4,$5,$6,$7)',[ctx.companyId,row.id,kind==='settlement'?id:'another-doc',row.doc_type,row.party_kind,row.party_id,row.amount])}
  await expected(f,'unverifiable','SHIPMENT_REVERSAL_MOVEMENTS_REMAIN')
 })
 it('a permanent delivered receipt contradicts cancellation even with cancelled text and a valid cancellation receipt',async()=>{
  const f=await posted();expect((await deliver(f)).statusCode).toBe(200)
  const r=(await ctx.pool.query("select * from order_lifecycle_commands where company_id=$1 and operation='delivered'",[ctx.companyId])).rows[0]
  await ctx.pool.query("delete from order_lifecycle_commands where company_id=$1 and operation='delivered'",[ctx.companyId]);await ctx.pool.query("update orders set status='shipped' where company_id=$1 and id=$2",[ctx.companyId,f.orderId]);expect((await cancelShipmentV2(ctx,f.orderId,f.payload)).statusCode).toBe(200)
  await ctx.pool.query('insert into order_lifecycle_commands(company_id,command_id,order_id,operation,canonical_payload,fingerprint,response_status,response_body) values($1,$2,$3,$4,$5,$6,$7,$8)',[r.company_id,r.command_id,r.order_id,r.operation,JSON.stringify(r.canonical_payload),r.fingerprint,r.response_status,JSON.stringify(r.response_body)])
  await expected(f,'unverifiable','SHIPMENT_REVERSAL_DELIVERY_CONFLICT')
 })
 it.each(['w1-qty','w2-qty','w2-cost'])('all-warehouse %s drift blocks reversal',async kind=>{
  const f=await cancelled();await ctx.pool.query(`update stock_balances set ${kind.endsWith('cost')?'cost_amount':'qty'}=999 where company_id=$1 and warehouse_id=$2 and product_id='p1'`,[ctx.companyId,kind.startsWith('w1')?'w1':'w2']);await expected(f,'unverifiable','SHIPMENT_REVERSAL_BALANCE_LEDGER_MISMATCH')
 })
 it.each(['w1','w2'])('includes archived %s and does not guess a replacement warehouse',async warehouse=>{
  const f=await cancelled();await ctx.pool.query('update warehouses set deleted_at=now() where company_id=$1 and id=$2',[ctx.companyId,warehouse]);const r=await expected(f,'reversed');expect(r.warehouses.find((w:any)=>w.id===warehouse).active).toBe(false);expect(r.totals[0].qtyBase).toBe('100.0000')
 })
 it('allows independent later receipts, transfers and inventories; does not restore a historical total',async()=>{
  const f=await cancelled()
  for(const document of [
   {id:randomUUID(),type:'receive',warehouseId:'w1',items:[{productId:'p1',qty:3,cost:9}]},
   {id:randomUUID(),type:'transfer',warehouseId:'w2',warehouseToId:'w1',items:[{productId:'p1',qty:4}]},
   {id:randomUUID(),type:'adjust',warehouseId:'w2',items:[{productId:'p1',qty:55}]}])expect((await call(ctx,'POST','/v1/documents/post',{document})).statusCode).toBe(201)
  const r=await expected(f,'reversed');expect(r.totals[0].qtyBase).toBe('102.0000');expect(r.balances).toEqual([{warehouseId:'w1',productId:'p1',qtyBase:'47.0000'},{warehouseId:'w2',productId:'p1',qtyBase:'55.0000'}])
 })
 it.each(['cancel','inventory'])('reads a single snapshot while %s commits between balances and proof reads',async transition=>{
  const f=transition==='cancel'?await posted():await cancelled(),c=await ctx.pool.connect();let committed=false
  const query=async(sql:string,values?:unknown[])=>{
   const r=await c.query(sql,values)
   if(sql.startsWith('select warehouse_id as')&&!committed){committed=true;expect((await c.query('show transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');expect((await c.query('show transaction_read_only')).rows[0].transaction_read_only).toBe('on')
    if(transition==='cancel')expect((await cancelShipmentV2(ctx,f.orderId,f.payload)).statusCode).toBe(200)
    else expect((await call(ctx,'POST','/v1/documents/post',{document:{id:randomUUID(),type:'adjust',warehouseId:'w1',items:[{productId:'p1',qty:31}]}})).statusCode).toBe(201)
   }return r
  }
  try{const before=await reconcileStock({...ctx.pool,connect:async()=>({query,release:()=>{}})} as any,ctx.companyId,request(f));expect(committed).toBe(true);expect(before.totals[0]!.qtyBase).toBe(transition==='cancel'?'98.0000':'100.0000');expect(before.commands[0]!.resolution).toBe(transition==='cancel'?'applied':'reversed')
   const after=await expected(f,'reversed');expect(after.totals[0].qtyBase).toBe(transition==='cancel'?'100.0000':'91.0000')
  }finally{c.release()}
 })
 it('an uncommitted cancellation never leaks its receipt or restored balance to a concurrent reader',async()=>{
  const f=await posted();let release!:()=>void,signal!:()=>void,paused=false;const ready=new Promise<void>(r=>{signal=r}),released=new Promise<void>(r=>{release=r})
  const pool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{const c=await ctx.pool.connect(),w=Object.create(c);w.release=c.release.bind(c);w.query=async(sql:string,values?:unknown[])=>{if(sql==='commit'&&!paused){paused=true;signal();await released}return c.query(sql,values)};return w}}
  const body={contractVersion:2,status:'cancelled',shipmentId:f.payload.shipmentId,shipmentFingerprint:saleFingerprint({companyId:ctx.companyId,orderId:f.orderId,...f.payload})}
  const pending=cancellationV2(pool,{companyId:ctx.companyId,userId:ctx.userId,role:'admin',email:null,memberName:'Test',isSuperAdmin:false},f.orderId,body,`cancelled:${f.payload.shipmentId}`)
  try{await ready;await cancelExpected(f,'not_observed');const before=await reconcile(f);expect(before.commands[0].resolution).toBe('applied');expect(before.totals[0].qtyBase).toBe('98.0000');release();expect((await pending).status).toBe(200);await expected(f,'reversed');await cancelExpected(f,'applied')}
  finally{release();await pending}
 })
 it('replay and read-only validation do not mutate any accounting, lifecycle or financial-fence facts',async()=>{
  const f=await cancelled(),before=await facts(),c=await ctx.pool.connect(),log:string[]=[]
  const query=async(sql:string,values?:unknown[])=>{log.push(sql);return c.query(sql,values)}
  try{const r=await reconcileStock({...ctx.pool,connect:async()=>({query,release:()=>{}})} as any,ctx.companyId,request(f));expect(r.commands[0]!.resolution).toBe('reversed');expect(log.some(sql=>/\b(insert|update|delete)\b|for share|pg_advisory|unpost_doc|post_doc/i.test(sql))).toBe(false);expect(await facts()).toEqual(before)}finally{c.release()}
  expect((await cancelShipmentV2(ctx,f.orderId,f.payload)).headers['idempotency-replayed']).toBe('true');expect(await facts()).toEqual(before);await expected(f,'reversed')
 })
 it('a lifecycle proof budget overflow is explicit rather than a truncated successful proof',async()=>{
  const f=await cancelled();await ctx.pool.query("update order_lifecycle_commands set response_body=jsonb_set(response_body,'{oversized}',to_jsonb(repeat('x',$2))) where company_id=$1 and operation='cancelled'",[ctx.companyId,STOCK_RECONCILE_LIMITS.responseBytes+1]);const r=await call(ctx,'POST','/v1/stock/reconcile',request(f));expect(r.statusCode).toBe(413);expect(r.json().error.code).toBe('STOCK_SNAPSHOT_TOO_LARGE')
 })
 it('isolates identical order/shipment/product identities across companies',async()=>{
  const f=await posted(),own=ctx,foreign=await setupIntegration()
  try{
   ctx=foreign;await seed();await prepare(f);expect((await post(f)).statusCode).toBe(200);ctx=own
   expect((await cancelShipmentV2(own,f.orderId,f.payload)).statusCode).toBe(200);await expected(f,'reversed')
   const r=await call(foreign,'POST','/v1/stock/reconcile',request(f));expect(r.statusCode).toBe(200);expect(r.json().commands[0].resolution).toBe('applied');expect(r.json().totals[0].qtyBase).toBe('98.0000')
  }finally{ctx=own;await foreign.close()}
 })
 it('rejects the obsolete nested cancellation envelope',async()=>{
  const f=await cancelled(),b=request(f);const r=await call(ctx,'POST','/v1/stock/reconcile',{...b,commands:[{commandId:`cancelled:${f.payload.shipmentId}`,kind:'order_cancel',idempotencyKey:`cancelled:${f.payload.shipmentId}`,payload:{orderId:f.orderId,request:{contractVersion:2,status:'cancelled',shipmentId:f.payload.shipmentId,shipmentFingerprint:'0'.repeat(64)}}}]});expect(r.statusCode).toBe(400)
 })
})
