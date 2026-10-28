import { describe,it,expect } from 'vitest'
import { requireKnownRole, requirePermission,canSyncTable,type Permission } from '../src/lib/permissions.js'
const allowed: Record<Permission,string[]> = {
 invite:['admin','manager'],manageRoles:['admin'],customerFinance:['admin','manager'],
 sale:['admin','manager','cashier'],return:['admin','manager','cashier'],commercial:['admin','manager'],
 warehouse:['admin','manager','stock'],cancel:['admin','manager'],delivery:['admin','manager','courier'],settings:['admin','manager'],
}
describe('explicit RBAC',()=>{
 for(const role of ['admin','manager','stock','courier','cashier','owner','warehouse','unknown','']) {
  it(`permissions for ${role || 'empty'}`,()=>{
   for(const permission of Object.keys(allowed) as Permission[]) {
    if(allowed[permission].includes(role)) expect(()=>requirePermission(role,permission)).not.toThrow()
    else expect(()=>requirePermission(role,permission)).toThrow()
   }
   expect(canSyncTable(role,'customers')).toBe(['admin','manager'].includes(role))
   expect(canSyncTable(role,'employees')).toBe(['admin','manager'].includes(role))
   expect(canSyncTable(role,'products')).toBe(['admin','manager','stock'].includes(role))
   if(['owner','warehouse','unknown',''].includes(role)) expect(()=>requireKnownRole(role)).toThrow()
  })
 }
})
