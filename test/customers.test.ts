import { describe, expect, it } from 'vitest'
import { authHeaders, COMPANY_ID, makeTestApp } from './helpers.js'

const code=(kind:string)=>kind==='payment'?'LEGACY_CUSTOMER_PAYMENT_REQUIRES_RECONCILIATION':'LEGACY_CUSTOMER_ADJUSTMENT_REQUIRES_RECONCILIATION'
const customer=(sql:string,params:unknown[])=>sql.includes('from customers')&&params[1]==='cu-1'?[{id:'cu-1'}]:undefined
const forbiddenWrite=(sql:string)=>/insert into|update |delete from|post_doc|begin|idempotency_keys|money_accounts|pg_advisory/.test(sql)
describe('legacy customer finance fence',()=>{
 for(const kind of ['payment','adjustment'])it(`${kind}: 422 before transaction, replay/account reads or writes`,async()=>{
  const {app,log}=await makeTestApp({handler:customer})
  const r=await app.inject({method:'POST',url:'/v1/customers/cu-1/payments',headers:await authHeaders({'idempotency-key':'legacy-finance-01'}),payload:{kind,amount:100}})
  expect(r.statusCode).toBe(422);expect(r.json().error.code).toBe(code(kind));expect(log.some(e=>forbiddenWrite(e.sql))).toBe(false)
 })
 it('kind is mandatory and unknown kinds/fields are rejected',async()=>{
  const {app,log}=await makeTestApp({handler:customer})
  for(const body of [{amount:10},{kind:'unknown',amount:10},{kind:'payment',amount:10,paymentMode:'cash'}]){
   const r=await app.inject({method:'POST',url:'/v1/customers/cu-1/payments',headers:await authHeaders({'idempotency-key':'legacy-finance-02'}),payload:body})
   expect(r.statusCode).toBe(400);expect(r.json().error.code).toBe('VALIDATION_ERROR')
  }
  expect(log.some(e=>forbiddenWrite(e.sql))).toBe(false)
 })
 it('missing own-company customer retains 404',async()=>{
  const {app}=await makeTestApp({handler:customer})
  expect((await app.inject({method:'POST',url:'/v1/customers/missing/payments',headers:await authHeaders({'idempotency-key':'legacy-finance-03'}),payload:{kind:'payment',amount:100}})).statusCode).toBe(404)
 })
 it('missing transport key retains validation error',async()=>{
  const {app}=await makeTestApp({handler:customer})
  expect((await app.inject({method:'POST',url:'/v1/customers/cu-1/payments',headers:await authHeaders(),payload:{kind:'payment',amount:100}})).statusCode).toBe(400)
 })
 it('courier remains forbidden',async()=>{
  const {app}=await makeTestApp({handler:customer,membership:{company_id:COMPANY_ID,role:'courier',name:'Courier'}})
  expect((await app.inject({method:'POST',url:'/v1/customers/cu-1/payments',headers:await authHeaders({'idempotency-key':'legacy-finance-04'}),payload:{kind:'payment',amount:100}})).statusCode).toBe(403)
 })
 it('existence query remains company/customer scoped',async()=>{
  const {app,log}=await makeTestApp({handler:customer})
  await app.inject({method:'POST',url:'/v1/customers/cu-1/payments',headers:await authHeaders({'idempotency-key':'legacy-finance-05'}),payload:{kind:'adjustment',amount:100}})
  const read=log.find(e=>e.sql.includes('from customers'))!
  expect(read.params).toEqual([COMPANY_ID,'cu-1']);expect(read.sql).toContain('deleted_at is null')
 })
 it('does not read an available successful temporary replay',async()=>{
  const {app,log}=await makeTestApp({handler:(sql,params)=>{if(sql.includes('idempotency_keys'))throw Error('Must not inspect temporary proof');return customer(sql,params)}})
  const r=await app.inject({method:'POST',url:'/v1/customers/cu-1/payments',headers:await authHeaders({'idempotency-key':'legacy-finance-06'}),payload:{kind:'payment',amount:100}})
  expect(r.statusCode).toBe(422);expect(r.headers['idempotency-replayed']).toBeUndefined();expect(log.some(e=>forbiddenWrite(e.sql))).toBe(false)
 })
})
