-- Existing invitations require reissue; never promote legacy plaintext to a credential.
alter table invitations
  add column secret_hash text,
  add column expires_at timestamptz,
  add column accepted_at timestamptz,
  add column accepted_by uuid references users(id) on delete set null,
  add column revoked_at timestamptz,
  add column requires_reissue boolean not null default false;
update invitations set requires_reissue=true, token=null;
create unique index invitations_secret_hash_unique on invitations(secret_hash) where secret_hash is not null;
alter table invitations add constraint invitation_hash_format check (secret_hash is null or secret_hash ~ '^[a-f0-9]{64}$');
alter table invitations add constraint invitation_acceptance_pair check (accepted_by is null or accepted_at is not null);
alter table invitations add constraint invitation_secret_expiry check (secret_hash is null or expires_at is not null);
alter table invitations add constraint invitation_no_plaintext_secret check (token is null);
