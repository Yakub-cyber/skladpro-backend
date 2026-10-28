import { cancelShipmentV2 } from './helpers.js'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowSkipIntegration, call, hasDb, integrationConfig, setupIntegration, type Ctx } from './helpers.js'
import { deliveryV2 } from '../../src/services/deliveriesV2.js'
import { buildApp } from '../../src/app.js'
import { runMigrations } from '../../src/migrate.js'
import { mapPgError } from '../../src/lib/errors.js'
import type { DbPool } from '../../src/db.js'

if (!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('0030 delivered shipment SQL guard — real PostgreSQL', () => {
  let ctx: Ctx
  beforeEach(async () => { ctx = await setupIntegration() })
  afterEach(async () => {
    if (ctx) {
      expect((await ctx.pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and (state='idle in transaction' or wait_event_type='Lock')")).rows[0].n).toBe(0)
      expect((await ctx.pool.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks).toBe('0')
      await ctx.close()
    }
  })
  const auth = () => ({ companyId: ctx.companyId, userId: ctx.userId, role: 'admin', email: null, memberName: 'Тест', isSuperAdmin: false })
  async function prepare() {
    const orderId = randomUUID(), shipmentId = randomUUID()
    const commercial = { items: [{ lineId: 'source', productId: 'p1', unitId: 'u-sht', unitFactor: '1', qtyInput: '2', qtyBase: '2', price: '50.00' }], customerId: 'c1', customerName: 'Customer', no: null, priceTypeId: null, shiftId: null,
      subtotal: '100.00', total: '100.00', discount: { kind: 'percent', value: '0' }, rounding: 'kopeck', onCredit: true, creditTerms: null, vatSummary: null,
      payment: { method: 'credit', cashPaid: '0', cardPaid: '0', change: '0' }, address: null, geo: null, courier: null, assignedTo: null, priority: false }
    expect((await call(ctx, 'POST', '/v1/orders', { contractVersion: 2, commandId: randomUUID(), orderId, commercial })).statusCode).toBe(201)
    expect((await call(ctx, 'POST', `/v1/orders/${orderId}/status`, { status: 'picking' })).statusCode).toBe(200)
    const shipment = { contractVersion: 2, status: 'shipped', shipmentId, warehouseId: 'w1', orderSnapshot: commercial }
    const posted = await call(ctx, 'POST', `/v1/orders/${orderId}/status`, shipment, `shipment:${shipmentId}`)
    expect(posted.statusCode).toBe(200)
    return { orderId, shipment, documentId: posted.json().documentId, body: { contractVersion: 2 as const, status: 'delivered' as const, shipmentId, shipmentFingerprint: posted.json().fingerprint as string } }
  }
  type Fixture = Awaited<ReturnType<typeof prepare>>
  const deliver = (f: Fixture, body: unknown = f.body, key = `delivered:${f.body.shipmentId}`) => call(ctx, 'POST', `/v1/orders/${f.orderId}/status`, body, key)

  async function facts() {
    const out: Record<string, unknown> = {}
    for (const table of ['orders','docs','doc_lines','stock_balances','stock_movements','money_movements','settlement_movements','products','customers','suppliers','money_accounts','audit','order_lifecycle_commands','order_commercial_commands','idempotency_keys'])
      out[table] = (await ctx.pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') rows from ${table} t where company_id=$1`, [ctx.companyId])).rows[0].rows
    return out
  }
  async function failure(f: Fixture, code: string, companyId = ctx.companyId) {
    const before = await facts()
    await expect(ctx.pool.query('select unpost_doc($1,$2)', [companyId, f.documentId])).rejects.toMatchObject({code})
    expect(await facts()).toEqual(before)
  }
  async function reconcile(f: Fixture) {
    const r = await call(ctx,'POST','/v1/stock/reconcile',{contractVersion:1,requestId:randomUUID(),productIds:['p1'],commands:[{kind:'order_status',commandId:f.orderId,idempotencyKey:`shipment:${f.body.shipmentId}`,payload:f.shipment}]})
    expect(r.statusCode).toBe(200); return r.json().commands[0].resolution
  }
  async function refund(f: Fixture, version = 2) {
    const returnId = randomUUID()
    return call(ctx,'POST','/v1/returns',version === 2 ? {contractVersion:2,returnId,orderId:f.orderId,items:[{saleLineId:`${f.documentId}:source`,qtyBase:'1'}]} : {orderId:f.orderId,items:[{productId:'p1',qty:1}]}, version === 2 ? `return:${returnId}` : randomUUID())
  }
  async function returnDraft(f: Fixture) {
    const id = `test-return-${randomUUID()}`
    await ctx.pool.query("insert into docs(company_id,id,doc_type,warehouse_id,order_id,party_kind,party_id) values($1,$2,'sales_return','w1',$3,'customer','c1')",[ctx.companyId,id,f.orderId])
    await ctx.pool.query("insert into doc_lines(company_id,id,doc_id,product_id,qty_input,qty,price) values($1,$2,$3,'p1',1,1,50)",[ctx.companyId,`${id}:line`,id])
    return id
  }
  async function waitBlocked(pid?: number) {
    for (let i=0;i<400;i++) {
      const r=pid ? await ctx.pool.query('select 1 where cardinality(pg_blocking_pids($1))>0',[pid]) : await ctx.pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'")
      if(r.rowCount) return
      await new Promise(r=>setTimeout(r,10))
    }
    throw Error('Expected an actual PostgreSQL lock wait')
  }
  function gateCommit() {
    let release!:()=>void, readyResolve!:()=>void, paused=false
    const ready=new Promise<void>(r=>{readyResolve=r}), released=new Promise<void>(r=>{release=r})
    const pool: DbPool={query:ctx.pool.query.bind(ctx.pool),end:ctx.pool.end.bind(ctx.pool),connect:async()=>{
      const real=await ctx.pool.connect(), wrapped=Object.create(real);wrapped.release=real.release.bind(real)
      wrapped.query=(...args:any[])=>{
        if(String(args[0]).toLowerCase()==='commit' && !paused){paused=true;readyResolve();return released.then(()=>(real.query as any)(...args))}
        return (real.query as any)(...args)
      };return wrapped
    }}
    return {pool,ready,release}
  }
  it('permits unpost before delivery and preserves post_doc exactly',async()=>{
    const f=await prepare()
    await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId])
    expect((await ctx.pool.query('select status from docs where company_id=$1 and id=$2',[ctx.companyId,f.documentId])).rows[0].status).toBe('draft')
    const sql=await readFile('sql/migrations/0027_guard_sale_returns.sql','utf8')
    const expected=sql.split('as $$')[1].split('$$;')[0].replace(/\r/g,'')
    expect((await ctx.pool.query("select prosrc from pg_proc where oid='public.post_doc(uuid,text)'::regprocedure")).rows[0].prosrc.replace(/\r/g,'')).toBe(expected)
  })
  it.each(['normal','later-status','no-receipt'])('blocks delivered shipment (%s), preserves all facts and applied proof',async kind=>{
    const f=await prepare();expect((await deliver(f)).statusCode).toBe(200)
    if(kind==='later-status') await ctx.pool.query("update orders set status='shipped' where company_id=$1 and id=$2",[ctx.companyId,f.orderId])
    if(kind==='no-receipt') await ctx.pool.query('delete from order_lifecycle_commands where company_id=$1 and order_id=$2',[ctx.companyId,f.orderId])
    await failure(f,'P0012');expect(await reconcile(f)).toBe('applied')
  })
  it.each(['json','unicode-json','overflow-json','null-json','array-json','wrong-kind','oversized','marker','snapshot','document-order','missing-document-order','receipt'])('fails closed for damaged %s, with a distinct reconciliation error',async kind=>{
    const f=await prepare();expect((await deliver(f)).statusCode).toBe(200)
    if(['json','unicode-json','overflow-json','null-json','array-json','wrong-kind','oversized'].includes(kind)) await ctx.pool.query('update docs set source_payload=$3 where company_id=$1 and id=$2',[ctx.companyId,f.documentId,kind==='json' ? '{' : kind==='unicode-json' ? '"\\u0000"' : kind==='overflow-json' ? '1e1000000' : kind==='null-json' ? 'null' : kind==='array-json' ? '[]' : kind==='wrong-kind' ? '{"kind":"legacy"}' : ' '.repeat(262145)])
    if(kind==='marker') await ctx.pool.query('update orders set shipment_doc_id=null where company_id=$1 and id=$2',[ctx.companyId,f.orderId])
    if(kind==='snapshot') await ctx.pool.query('update orders set commercial_snapshot=null where company_id=$1 and id=$2',[ctx.companyId,f.orderId])
    if(kind==='document-order') {
      await ctx.pool.query("insert into orders(company_id,id,status) values($1,'other-order','shipped')",[ctx.companyId])
      await ctx.pool.query("update docs set order_id='other-order' where company_id=$1 and id=$2",[ctx.companyId,f.documentId])
    }
    if(kind==='missing-document-order') await ctx.pool.query('update docs set order_id=null where company_id=$1 and id=$2',[ctx.companyId,f.documentId])
    if(kind==='receipt') await ctx.pool.query("update order_lifecycle_commands set response_body='{}' where company_id=$1 and order_id=$2",[ctx.companyId,f.orderId])
    await failure(f,'P0013')
  })
  it('invalid JSON without a receipt cannot bypass the delivered protected status',async()=>{
    const f=await prepare();expect((await deliver(f)).statusCode).toBe(200)
    await ctx.pool.query('delete from order_lifecycle_commands where company_id=$1',[ctx.companyId])
    await ctx.pool.query("update docs set source_payload='not json' where company_id=$1 and id=$2",[ctx.companyId,f.documentId])
    await failure(f,'P0013')
  })
  it.each([1,2])('retains P0010 priority for posted return v%s, and permits unposting the return itself',async version=>{
    const f=await prepare();expect((await deliver(f)).statusCode).toBe(200)
    const r=await refund(f,version);expect(r.statusCode,r.body).toBe(201)
    await failure(f,'P0010')
    const doc=(await ctx.pool.query("select id from docs where company_id=$1 and order_id=$2 and doc_type in ('sales_return','retail_return')",[ctx.companyId,f.orderId])).rows[0].id
    await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,doc])
    expect((await ctx.pool.query('select status from docs where company_id=$1 and id=$2',[ctx.companyId,doc])).rows[0].status).toBe('draft')
    await failure(f,'P0012')
  })
  it('preserves historical legacy delivered unposting and arbitrary legacy text',async()=>{
    const id=randomUUID()
    const r=await call(ctx,'POST','/v1/sales',{order:{id,items:[{productId:'p1',qty:1,price:50}]}});expect(r.statusCode).toBe(201)
    await ctx.pool.query("update docs set source_payload='old free text' where company_id=$1 and id=$2",[ctx.companyId,`sale-${id}`])
    await ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,`sale-${id}`])
    expect((await ctx.pool.query('select status from docs where company_id=$1 and id=$2',[ctx.companyId,`sale-${id}`])).rows[0].status).toBe('draft')
  })
  it('rejects another company even with the same document identity',async()=>{
    const f=await prepare();expect((await deliver(f)).statusCode).toBe(200)
    await failure(f,'P0002',randomUUID())
  })
  it('maps new and existing SQL conflicts to stable HTTP 409 codes',()=>{
    for(const [code,api] of [['P0010','SALE_HAS_POSTED_RETURNS'],['P0012','DELIVERED_ORDER_CANCELLATION_FORBIDDEN'],['P0013','DELIVERED_SHIPMENT_RECONCILIATION_REQUIRED']]) expect(mapPgError({code,message:'blocked'})).toMatchObject({statusCode:409,code:api})
  })
  it.each(['read committed','repeatable read','serializable'])('%s unpost sees a delivery committed after its initial snapshot',async isolation=>{
    const f=await prepare(),c=await ctx.pool.connect()
    try {
      await c.query(`begin isolation level ${isolation}`);await c.query("set local statement_timeout='5s'")
      await c.query('select id from orders where company_id=$1 and id=$2',[ctx.companyId,f.orderId])
      expect((await deliver(f)).statusCode).toBe(200)
      const before=await facts()
      await expect(c.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId])).rejects.toMatchObject({code:isolation==='read committed'?'P0012':'40001'})
      await c.query('rollback');expect(await facts()).toEqual(before)
      await failure(f,'P0012') // a new transaction observes the winner after 40001
    }finally{await c.query('rollback');c.release()}
  })
  it.each(['delivery-first','unpost-first'])('%s serializes real delivery and SQL unpost without deadlock',async order=>{
    const f=await prepare()
    if(order==='delivery-first') {
      const gate=gateCommit(),first=deliveryV2(gate.pool,auth(),f.orderId,f.body,`delivered:${f.body.shipmentId}`)
      let second:Promise<any>|undefined
      try {await gate.ready;second=ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId]).then(()=>null,e=>e)
        await waitBlocked();gate.release();await first;expect((await second).code).toBe('P0012');expect(await reconcile(f)).toBe('applied')
      }finally{gate.release();await first;await second}
    }else{
      const c=await ctx.pool.connect();let second:ReturnType<typeof deliver>|undefined
      try{await c.query('begin');await c.query("set local statement_timeout='5s'");await c.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId])
        second=deliver(f);await waitBlocked();await c.query('commit');expect((await second).statusCode).toBe(409)
      }finally{await c.query('rollback');c.release();await second}
    }
  })
  it.each(['return-first','unpost-first'])('%s serializes SQL return posting and SQL unpost before delivery',async order=>{
    const f=await prepare(),ret=await returnDraft(f),a=await ctx.pool.connect(),b=await ctx.pool.connect()
    try{
      for(const c of [a,b]){await c.query('begin');await c.query("set local statement_timeout='5s'")}
      const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid
      const first=order==='return-first'?'post_doc':'unpost_doc',second=order==='return-first'?'unpost_doc':'post_doc'
      await a.query(`select ${first}($1,$2)`,[ctx.companyId,order==='return-first'?ret:f.documentId])
      const pending=b.query(`select ${second}($1,$2)`,[ctx.companyId,order==='return-first'?f.documentId:ret]).then(()=>null,e=>e)
      await waitBlocked(pid);await a.query('commit');const before=await facts()
      expect((await pending).code).toBe(order==='return-first'?'P0010':'P0011');await b.query('rollback');expect(await facts()).toEqual(before)
    }finally{await a.query('rollback');await b.query('rollback');a.release();b.release()}
  })
  it.each(['return-first','unpost-first'])('%s: delivered return v2 and SQL unpost serialize with P0010/P0012',async order=>{
    const f=await prepare();expect((await deliver(f)).statusCode).toBe(200)
    if(order==='return-first'){
      const gate=gateCommit()
      await ctx.app.close();ctx.app=await buildApp({config:integrationConfig(),pool:gate.pool,eventBus:null,fcm:null,metrics:null})
      const first=refund(f);let second:Promise<any>|undefined
      try{await gate.ready;second=ctx.pool.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId]).then(()=>null,e=>e)
        await waitBlocked();gate.release();expect((await first).statusCode).toBe(201);expect((await second).code).toBe('P0010')
      }finally{gate.release();await first;await second}
    }else{
      const c=await ctx.pool.connect();let second:ReturnType<typeof refund>|undefined
      try{await c.query('begin');await c.query("set local statement_timeout='5s'")
        await c.query('select id from orders where company_id=$1 and id=$2 for update',[ctx.companyId,f.orderId])
        second=refund(f);await waitBlocked();await c.query('savepoint attempt')
        await expect(c.query('select unpost_doc($1,$2)',[ctx.companyId,f.documentId])).rejects.toMatchObject({code:'P0012'})
        await c.query('rollback to savepoint attempt');await c.query('commit');expect((await second).statusCode).toBe(201)
      }finally{await c.query('rollback');c.release();await second}
    }
    await failure(f,'P0010');expect(await reconcile(f)).toBe('applied')
  })
  it.each(['delivery-first','cancel-first'])('%s HTTP cancel/delivered keeps lock order and accounting',async order=>{
    const f=await prepare(),gate=gateCommit();let first:Promise<any>,second:Promise<any>|undefined
    if(order==='delivery-first')first=deliveryV2(gate.pool,auth(),f.orderId,f.body,`delivered:${f.body.shipmentId}`)
    else{await ctx.app.close();ctx.app=await buildApp({config:integrationConfig(),pool:gate.pool,eventBus:null,fcm:null,metrics:null});first=Promise.resolve(cancelShipmentV2(ctx,f.orderId,f.shipment))}
    try{await gate.ready;second=order==='delivery-first'?Promise.resolve(cancelShipmentV2(ctx,f.orderId,f.shipment)):deliver(f)
      await waitBlocked();gate.release();await first;expect((await second).statusCode).toBe(409)
    }finally{gate.release();await first;await second}
  })
  it('deploys all migrations including 0030 with the unmodified runner on a separate empty database',async()=>{
    const db=`guard_fresh_${randomUUID().replaceAll('-','')}`
    await ctx.pool.query(`create database ${db}`)
    const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname=`/${db}`
    const p=new pg.Pool({connectionString:url.toString()})
    try{
      await runMigrations(p,()=>{})
      const migrationCount=(await readdir('sql/migrations')).filter(f=>f.endsWith('.sql')).length
      expect((await p.query('select count(*)::int n from schema_migrations')).rows[0].n).toBe(migrationCount)
      expect((await p.query("select prosrc from pg_proc where oid='unpost_doc(uuid,text)'::regprocedure")).rows[0].prosrc).toContain("errcode = 'P0012'")
      await runMigrations(p,()=>{})
      expect((await p.query('select count(*)::int n from schema_migrations')).rows[0].n).toBe(migrationCount)
    }finally{await p.end()}
  })
  it('upgrades 0029 to 0030 without data changes, deploys from scratch and reruns the runner',async()=>{
    const db=`guard_migrations_${randomUUID().replaceAll('-','')}`
    // A new database on the explicitly configured TEST server; never production.
    await ctx.pool.query(`create database ${db}`)
    const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname=`/${db}`
    const p=new pg.Pool({connectionString:url.toString()})
    try{
      const files=(await readdir('sql/migrations')).filter(f=>f.endsWith('.sql')).sort()
      await p.query('create table schema_migrations(name text primary key,applied_at timestamptz not null default now())')
      for(const f of files.filter(f=>f<'0030')){
        const c=await p.connect();try{await c.query('begin');await c.query(await readFile(`sql/migrations/${f}`,'utf8'));await c.query('insert into schema_migrations(name) values($1)',[f]);await c.query('commit')}finally{c.release()}
      }
      const sql=await readFile('sql/migrations/0027_guard_sale_returns.sql','utf8')
      const normalize=(s:string)=>s.replace(/\r/g,'')
      for(const name of ['post_doc','unpost_doc']){
        const r=await p.query('select pg_get_functiondef(oid) definition,prosrc from pg_proc where oid=$1::regprocedure',[`public.${name}(uuid,text)`])
        const expected=sql.slice(sql.indexOf(`create or replace function ${name}`)).split('as $$')[1].split('$$;')[0]
        expect(normalize(r.rows[0].prosrc)).toBe(normalize(expected));expect(r.rows[0].definition).toContain(`FUNCTION public.${name}`)
      }
      // Seed a historical row to detect any backfill/rewriting during upgrade.
      const company=randomUUID()
      await p.query("insert into companies(id,name) values($1,'migration-history')",[company])
      await p.query("insert into orders(company_id,id,status) values($1,'history','delivered')",[company])
      const snapshot=async()=>{
        const out:Record<string,unknown>={}
        for(const t of ['orders','docs','stock_balances','stock_movements','money_movements','settlement_movements','order_lifecycle_commands'])out[t]=(await p.query(`select to_jsonb(t) r from ${t} t order by to_jsonb(t)::text`)).rows
        return out
      }
      const schema=async()=>({columns:(await p.query("select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows, constraints:(await p.query("select conrelid::regclass::text relation,conname,pg_get_constraintdef(oid) definition from pg_constraint where connamespace='public'::regnamespace order by relation,conname")).rows,triggers:(await p.query("select tgrelid::regclass::text relation,tgname,pg_get_triggerdef(oid) definition from pg_trigger where not tgisinternal order by relation,tgname")).rows})
      const schemaBefore=await schema()
      const before=await snapshot(),postBefore=(await p.query("select pg_get_functiondef('post_doc(uuid,text)'::regprocedure) d")).rows[0].d
      // Isolate the 0030 schema-invariance assertion from subsequent migrations.
      await p.query(await readFile('sql/migrations/0030_guard_delivered_unpost.sql','utf8'))
      await p.query("insert into schema_migrations(name) values('0030_guard_delivered_unpost.sql')")
      expect(await snapshot()).toEqual(before);expect(await schema()).toEqual(schemaBefore)
      await runMigrations(p,()=>{})
      expect((await p.query("select pg_get_functiondef('post_doc(uuid,text)'::regprocedure) d")).rows[0].d).toBe(postBefore)
      expect((await p.query('select count(*)::int n from schema_migrations')).rows[0].n).toBe(files.length)
      const unpost=(await p.query("select prosrc from pg_proc where oid='unpost_doc(uuid,text)'::regprocedure")).rows[0].prosrc
      expect(normalize(unpost)).toBe(normalize((await readFile('sql/migrations/0030_guard_delivered_unpost.sql','utf8')).split('as $$')[1].split('$$;')[0]))
      await runMigrations(p,()=>{});expect(await snapshot()).toEqual(before)
      expect((await p.query('select count(*)::int n from schema_migrations')).rows[0].n).toBe(files.length)
    }finally{await p.end()}
  })
})
