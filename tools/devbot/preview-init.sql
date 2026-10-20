-- Fix only the shipped placeholder in the isolated preview database.
-- An administrator's subsequently changed password is never overwritten.
UPDATE users
SET password_hash = crypt('admin', gen_salt('bf', 12))
WHERE username = 'admin'
  AND password_hash = '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQyCNNEMwdGTMaKTFCeHxOVA2';
