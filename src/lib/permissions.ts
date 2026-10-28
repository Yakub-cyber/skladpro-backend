import type { Queryable } from '../db.js'
import { Errors } from './errors.js'
export const HUMAN_ROLES = ['admin', 'manager', 'stock', 'courier', 'cashier'] as const
export type Permission = 'invite' | 'manageRoles' | 'customerFinance' | 'sale' | 'return' | 'commercial' | 'warehouse' | 'cancel' | 'delivery' | 'settings'
const permissions: Record<Permission, readonly string[]> = {
 invite: ['admin','manager'], manageRoles: ['admin'], customerFinance: ['admin','manager'],
 sale: ['admin','manager','cashier'], return: ['admin','manager','cashier'],
 commercial: ['admin','manager'], warehouse: ['admin','manager','stock'],
 cancel: ['admin','manager'], delivery: ['admin','manager','courier'], settings: ['admin','manager'],
}
export function requirePermission(role: string, permission: Permission) {
 if (!permissions[permission].includes(role)) throw Errors.forbidden()
}
export function requireKnownRole(role: string) {
 if (!(HUMAN_ROLES as readonly string[]).includes(role)) throw Errors.forbidden('Неизвестная роль')
}
export function canSyncTable(role: string, table: string) {
 if (role === 'admin' || role === 'manager') return true
 if (role === 'stock') return ['products','warehouses','cells','suppliers','invoices'].includes(table)
 if (role === 'cashier') return table === 'shifts'
 return false
}

// Historical assignments may be user ids, employee ids or membership names.
// A name is accepted only if it resolves to exactly one active courier.
export async function requireAssignedDelivery(db: Queryable, auth: {role:string;companyId:string;userId:string}, assignedTo: unknown) {
 if (auth.role !== 'courier') return
 if (typeof assignedTo !== 'string' || !assignedTo) throw Errors.forbidden('Курьер может доставлять только назначенный ему заказ')
 const {rows}=await db.query(`select distinct m.user_id from memberships m
  where m.company_id=$1 and m.active and m.role='courier' and
  (m.user_id::text=$2 or m.name=$2 or exists(select 1 from employees e
   where e.company_id=m.company_id and e.user_id=m.user_id and e.id=$2 and e.active and e.deleted_at is null))`,[auth.companyId,assignedTo])
 if(rows.length!==1 || rows[0].user_id!==auth.userId) throw Errors.forbidden('Назначение курьера не подтверждено или неоднозначно')
}
