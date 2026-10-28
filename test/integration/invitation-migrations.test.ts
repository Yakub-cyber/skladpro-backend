import { randomUUID } from 'node:crypto'
import { readdir,readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe,it,expect } from 'vitest'
import { hasDb,allowSkipIntegration } from './helpers.js'
import { runMigrations } from '../../src/migrate.js'
if(!hasDb && !allowSkipIntegration) throw new Error('TEST_DATABASE_URL required')
describe.skipIf(!hasDb)('invitation migration fresh/upgrade PostgreSQL',()=>{
 it.each(['fresh','upgrade'])('%s and repeated runner preserve accounts and memberships',async mode=>{
  const url=new URL(process.env.TEST_DATABASE_URL!)
  // Additional disposable databases are created only on the isolated local server.
  if(!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Local isolated PostgreSQL required')
  const admin=new Pool({connectionString:url.toString()}), name='invite_migration_'+randomUUID().replaceAll('-','')
  await admin.query(`create database "${name}"`);await admin.end();url.pathname='/'+name
  const pool=new Pool({connectionString:url.toString()})
  try {
   if(mode==='fresh') await runMigrations(pool,()=>{})
   else {
    await pool.query('create table schema_migrations(name text primary key, applied_at timestamptz not null default now())')
    const directory=new URL('../../sql/migrations/',import.meta.url)
    for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql') && f<'0033').sort()) {
     const client=await pool.connect()
     try { await client.query('begin');await client.query(await readFile(new URL(file,directory),'utf8'));await client.query('insert into schema_migrations(name) values($1)',[file]);await client.query('commit') } finally {client.release()}
    }
   }
   const company=randomUUID(),user=randomUUID(),inv=randomUUID()
   await pool.query("insert into users(id,email,password_hash) values($1,'legacy@example.test','unchanged')",[user])
   await pool.query("insert into companies(id,name) values($1,'Legacy')",[company])
   await pool.query("insert into memberships(user_id,company_id,role) values($1,$2,'admin')",[user,company])
   if(mode==='upgrade') await pool.query("insert into invitations(id,company_id,email,token) values($1,$2,'old@example.test','legacy-test-secret')",[inv,company])
   await runMigrations(pool,()=>{});await runMigrations(pool,()=>{})
   expect((await pool.query('select password_hash from users where id=$1',[user])).rows[0].password_hash).toBe('unchanged')
   expect((await pool.query('select role from memberships where user_id=$1',[user])).rows[0].role).toBe('admin')
   expect((await pool.query('select count(*)::int n from schema_migrations')).rows[0].n).toBe(33)
   if(mode==='upgrade') {
    const old=(await pool.query('select token,secret_hash,requires_reissue from invitations where id=$1',[inv])).rows[0]
    expect(old).toEqual({token:null,secret_hash:null,requires_reissue:true})
   }
   const accepted=(await pool.query("select count(*)::int n from stock_movements union all select count(*)::int from money_movements union all select count(*)::int from settlement_movements")).rows
   expect(accepted.every(r=>r.n===0)).toBe(true)
  } finally {await pool.end()}
 })
})
