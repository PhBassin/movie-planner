-- Enforce one live auth email token per (user, purpose), matching the
-- repository upsert used for verification and password-reset requests.

BEGIN;

-- Remove any legacy duplicates before adding the unique key.
DELETE FROM auth_email_tokens older
USING auth_email_tokens newer
WHERE older.user_id = newer.user_id
  AND older.purpose = newer.purpose
  AND older.id < newer.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_email_tokens_user_purpose
  ON auth_email_tokens(user_id, purpose);

COMMIT;
