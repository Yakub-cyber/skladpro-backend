import { randomUUID } from 'node:crypto'
import { beforeEach,afterEach,describe,it,expect } from 'vitest'
import { setupIntegration,hasDb,allowSkipIntegration,call,integrationConfig,type Ctx } from './helpers.js'
import { makeTokenService } from '../../src/lib/tokens.js'
import { invitationHash } from '../../src/services/invitations.js'
if(!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('invitation security and RBAC PostgreSQL',()=>{
 let ctx:Ctx, users:string[]=[]
 beforeEach(async()=>{ctx=await setupIntegration();users=[]})
 afterEach(async()=>{ if(!ctx)return; await ctx.app.close(); await ctx.pool.query('delete from companies where id=$1',[ctx.companyId]); for(const id of [...users,ctx.userId]) await ctx.pool.query('delete from users where id=$1',[id]); await ctx.pool.end() })
 async function actor(email=`invite-${randomUUID()}@example.test`,role?:string) {
  const id=randomUUID();users.push(id)
  await ctx.pool.query("insert into users(id,email,password_hash) values($1,$2,'test-only')",[id,email])
  if(role) await ctx.pool.query('insert into memberships(user_id,company_id,role) values($1,$2,$3)',[id,ctx.companyId,role])
  const token=await makeTokenService(integrationConfig()).signAccessToken({sub:id,email})
  return {id,email,headers:{authorization:`Bearer ${token}`,'x-company-id':ctx.companyId}}
 }
 async function invite(email:string,role='stock') {
  const r=await call(ctx,'POST','/v1/invitations',{email,role});expect(r.statusCode).toBe(201);return r.json()
 }
 async function accept(who:Awaited<ReturnType<typeof actor>>,token?:string) {
  return ctx.app.inject({method:'POST',url:'/v1/invitations/accept',headers:who.headers,payload:token?{token}:{}})
 }
 it('registration of the invited email without a secret cannot join',async()=>{
  const email=`unverified-${randomUUID()}@example.test`;await invite(email)
  const reg=await ctx.app.inject({method:'POST',url:'/v1/auth/register',payload:{email,password:'test-password-strong'}})
  expect(reg.statusCode).toBe(201);users.push(reg.json().user.id)
  const r=await ctx.app.inject({method:'POST',url:'/v1/invitations/accept',headers:{authorization:`Bearer ${reg.json().accessToken}`},payload:{}})
  expect(r.statusCode).toBe(400)
  expect((await ctx.pool.query('select 1 from memberships where user_id=$1',[reg.json().user.id])).rowCount).toBe(0)
 })
 it('valid one-time proof, concurrent replay, no plaintext in storage/list, history retained',async()=>{
  const user=await actor(),inv=await invite(user.email)
  const saved=(await ctx.pool.query('select * from invitations where id=$1',[inv.id])).rows[0]
  expect(saved.token===null).toBe(true);expect(saved.secret_hash===invitationHash(inv.token)).toBe(true)
  expect(Math.abs(new Date(saved.expires_at).getTime()-Date.now()-7*86400000)).toBeLessThan(10000)
  const list=await call(ctx,'GET','/v1/invitations');expect(list.body.includes(inv.token)).toBe(false);expect(list.body.includes(saved.secret_hash)).toBe(false)
  const results=await Promise.all([accept(user,inv.token),accept(user,inv.token)])
  expect(results.map(r=>r.statusCode)).toEqual([200,200])
  expect((await ctx.pool.query('select 1 from memberships where user_id=$1 and company_id=$2',[user.id,ctx.companyId])).rowCount).toBe(1)
  await ctx.pool.query('delete from memberships where user_id=$1',[user.id])
  expect((await accept(user,inv.token)).statusCode).toBe(200)
  expect((await ctx.pool.query('select 1 from memberships where user_id=$1',[user.id])).rowCount).toBe(0)
  expect((await ctx.pool.query('select accepted_by from invitations where id=$1',[inv.id])).rows[0].accepted_by).toBe(user.id)
 })
 it('wrong database email is rejected even if JWT email matches',async()=>{
  const target=await actor(),other=await actor(),inv=await invite(target.email)
  other.headers.authorization=`Bearer ${await makeTokenService(integrationConfig()).signAccessToken({sub:other.id,email:target.email})}`
  const r=await accept(other,inv.token);expect(r.statusCode).toBe(403);expect(r.json().error.code).toBe('INVITATION_EMAIL_MISMATCH')
 })
 it.each(['expired','revoked','legacy'])('%s is fail closed',async state=>{
  const user=await actor(),inv=await invite(user.email)
  if(state==='expired') await ctx.pool.query("update invitations set expires_at=now()-interval '1 second' where id=$1",[inv.id])
  if(state==='revoked') {
   const r=await ctx.app.inject({method:'DELETE',url:`/v1/invitations/${inv.id}`,headers:{authorization:`Bearer ${ctx.token}`,'x-company-id':ctx.companyId}});expect(r.statusCode).toBe(200)
  }
  if(state==='legacy') await ctx.pool.query('update invitations set requires_reissue=true,secret_hash=null where id=$1',[inv.id])
  expect((await accept(user,inv.token)).statusCode).toBe(410)
  expect((await ctx.pool.query('select 1 from memberships where user_id=$1',[user.id])).rowCount).toBe(0)
  expect((await ctx.pool.query('select 1 from invitations where id=$1',[inv.id])).rowCount).toBe(1)
 })
 it('registration with a valid secret consumes the same proof transactionally',async()=>{
  const email=`new-${randomUUID()}@example.test`,inv=await invite(email)
  const r=await ctx.app.inject({method:'POST',url:'/v1/auth/register',payload:{email,password:'test-password-strong',inviteToken:inv.token}})
  expect(r.statusCode).toBe(201);users.push(r.json().user.id)
  expect((await ctx.pool.query('select 1 from memberships where user_id=$1 and company_id=$2',[r.json().user.id,ctx.companyId])).rowCount).toBe(1)
 })
 it('manager cannot invite admin or change roles',async()=>{
  const manager=await actor(undefined,'manager')
  expect((await ctx.app.inject({method:'POST',url:'/v1/invitations',headers:manager.headers,payload:{email:'target@example.test',role:'admin'}})).statusCode).toBe(403)
  expect((await ctx.app.inject({method:'PATCH',url:`/v1/memberships/${ctx.userId}`,headers:manager.headers,payload:{role:'stock'}})).statusCode).toBe(403)
  expect((await ctx.app.inject({method:'POST',url:'/v1/invitations',headers:manager.headers,payload:{email:'target@example.test',role:'stock'}})).statusCode).toBe(201)
 })
 it.each(['stock','courier','cashier','unknown','owner'])('%s cannot bypass finance guards',async role=>{
  const user=await actor(undefined,role)
  for(const kind of ['payment','adjustment']) expect((await ctx.app.inject({method:'POST',url:'/v1/customers/c1/payments',headers:{...user.headers,'idempotency-key':randomUUID()},payload:{amount:10,kind}})).statusCode).toBe(403)
  const r=await ctx.app.inject({method:'POST',url:'/v1/sync/push',headers:user.headers,payload:{ops:[{table:'customers',op:'upsert',row:{id:'c1',balance:999}},{table:'employees',op:'upsert',row:{id:'evil',role:'admin'}}]}})
  expect([207,403].includes(r.statusCode)).toBe(true)
  expect((await ctx.pool.query('select balance::text from customers where company_id=$1 and id=$2',[ctx.companyId,'c1'])).rows[0].balance).toBe('0')
 })
 it('stock cannot use sales, returns, cancellation or legacy shipment for finance',async()=>{
  const user=await actor(undefined,'stock')
  for(const url of ['/v1/sales','/v1/returns','/v1/orders']) expect((await ctx.app.inject({method:'POST',url,headers:user.headers,payload:{}})).statusCode).toBe(403)
  for(const status of ['cancelled','shipped','delivered']) expect((await ctx.app.inject({method:'POST',url:'/v1/orders/missing/status',headers:{...user.headers,'idempotency-key':randomUUID()},payload:{status}})).statusCode).toBe(403)
 })
 it('tenant isolation: caller cannot create/revoke in another company',async()=>{
  const outsider=await actor(),inv=await invite(outsider.email)
  expect((await ctx.app.inject({method:'POST',url:'/v1/invitations',headers:outsider.headers,payload:{email:outsider.email}})).statusCode).toBe(403)
  expect((await ctx.app.inject({method:'DELETE',url:`/v1/invitations/${inv.id}`,headers:outsider.headers})).statusCode).toBe(403)
  expect((await accept(outsider,inv.token)).statusCode).toBe(200)
 })
 it('courier delivers only the assigned historical order',async()=>{
  const courier=await actor(undefined,'courier'), own=randomUUID(),foreign=randomUUID()
  await ctx.pool.query("insert into orders(company_id,id,status,stock_consumed,assigned_to) values($1,$2,'shipped',true,$4),($1,$3,'shipped',true,'another-user')",[ctx.companyId,own,foreign,courier.id])
  const send=(id:string)=>ctx.app.inject({method:'POST',url:`/v1/orders/${id}/status`,headers:{...courier.headers,'idempotency-key':randomUUID()},payload:{status:'delivered'}})
  expect((await send(foreign)).statusCode).toBe(403)
  expect((await send(own)).statusCode).toBe(200)
 })
 it('revoking or demoting a membership takes effect on the next request across cache boundaries',async()=>{
  const admin=await actor(undefined,'admin')
  const send=()=>ctx.app.inject({method:'POST',url:'/v1/invitations',headers:admin.headers,payload:{email:'target@example.test',role:'admin'}})
  expect((await send()).statusCode).toBe(201)
  await ctx.pool.query("update memberships set role='stock' where user_id=$1",[admin.id])
  expect((await send()).statusCode).toBe(403)
  await ctx.pool.query('update memberships set active=false where user_id=$1',[admin.id])
  expect((await send()).statusCode).toBe(403)
 })
 it('acceptance rolls back membership creation if consuming the proof fails',async()=>{
  const user=await actor(),inv=await invite(user.email),client=await ctx.pool.connect()
  try {
   await client.query('begin')
   await client.query("create function pg_temp.reject_invitation_accept() returns trigger language plpgsql as $$ begin raise exception 'test rollback'; end $$")
   await client.query('create trigger test_invitation_reject before update on invitations for each row execute function pg_temp.reject_invitation_accept()')
   // HTTP uses a different connection; uncommitted trigger would hold a table lock.
   // Exercise the same service on this transaction to prove atomic rollback.
   const {acceptInvitation}=await import('../../src/services/invitations.js')
   await expect(acceptInvitation(client,user.id,inv.token)).rejects.toThrow('test rollback')
   await client.query('rollback')
  } finally {client.release()}
  expect((await ctx.pool.query('select 1 from memberships where user_id=$1',[user.id])).rowCount).toBe(0)
  expect((await ctx.pool.query('select accepted_at from invitations where id=$1',[inv.id])).rows[0].accepted_at).toBe(null)
 })

 it('courier employee-id assignments are owned and names must be unambiguous',async()=>{
  const first=await actor(undefined,'courier'),other=await actor(undefined,'courier'),order=randomUUID()
  await ctx.pool.query("update memberships set name='Same courier' where company_id=$1 and user_id=any($2::uuid[])",[ctx.companyId,[first.id,other.id]])
  await ctx.pool.query("insert into employees(company_id,id,name,role,user_id) values($1,'courier-owned','Same courier','courier',$2)",[ctx.companyId,first.id])
  await ctx.pool.query("insert into orders(company_id,id,status,stock_consumed,assigned_to) values($1,$2,'shipped',true,'Same courier')",[ctx.companyId,order])
  const send=()=>ctx.app.inject({method:'POST',url:`/v1/orders/${order}/status`,headers:{...first.headers,'idempotency-key':randomUUID()},payload:{status:'delivered'}})
  expect((await send()).statusCode).toBe(403)
  const steal=await ctx.app.inject({method:'POST',url:'/v1/employees/me',headers:other.headers,payload:{id:'courier-owned',name:'Other',role:'admin'}})
  expect(steal.statusCode).toBe(403)
  expect((await ctx.pool.query("select user_id from employees where company_id=$1 and id='courier-owned'",[ctx.companyId])).rows[0].user_id).toBe(first.id)
  await ctx.pool.query("update orders set assigned_to='courier-owned' where company_id=$1 and id=$2",[ctx.companyId,order])
  expect((await send()).statusCode).toBe(200)
 })

})
