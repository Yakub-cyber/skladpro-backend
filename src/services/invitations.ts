import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { ApiError } from '../lib/errors.js'
export const InvitationSecret = z.string().regex(/^[A-Za-z0-9_-]{32}$/)
export const AcceptInvitationBody = z.object({ token: InvitationSecret }).strict()
export const invitationHash = (token: string) => createHash('sha256').update(token).digest('hex')
export async function acceptInvitation(client: PoolClient, userId: string, token: string) {
 const inv = (await client.query(`select * from invitations where secret_hash=$1 for update`,[invitationHash(token)])).rows[0]
 if (!inv || inv.requires_reissue || !['admin','manager','stock','courier'].includes(inv.role)) throw new ApiError(410,'INVITATION_INVALID','Приглашение недействительно; запросите новую ссылку')
 // Read the database identity, never treat JWT email as proof.
 const user = (await client.query('select email from users where id=$1 and active',[userId])).rows[0]
 if (!user || user.email.toLowerCase() !== inv.email.toLowerCase()) throw new ApiError(403,'INVITATION_EMAIL_MISMATCH','Войдите с email, указанным в приглашении')
 if (inv.accepted_at) {
  if (inv.accepted_by !== userId) throw new ApiError(409,'INVITATION_USED','Приглашение уже использовано')
  // Replay does not recreate revoked/deleted membership.
  return { ok:true, companyId:inv.company_id, replayed:true }
 }
 if (inv.revoked_at) throw new ApiError(410,'INVITATION_REVOKED','Приглашение отозвано')
 if (!inv.expires_at || (await client.query('select $1::timestamptz <= clock_timestamp() as expired',[inv.expires_at])).rows[0]?.expired) throw new ApiError(410,'INVITATION_EXPIRED','Срок приглашения истёк; запросите новую ссылку')
 await client.query(`insert into memberships(user_id,company_id,role,name) values($1,$2,$3,$4)
  on conflict(user_id,company_id) do nothing`,[userId,inv.company_id,inv.role,inv.name])
 await client.query('update invitations set accepted_at=now(),accepted_by=$2 where id=$1',[inv.id,userId])
 return {ok:true,companyId:inv.company_id,replayed:false}
}
