-- GitHub logins are case-insensitive, and the site now keeps them lowercase everywhere: sign-in
-- stores the lowercase login in the session, as the lab's tickets always did, so an owner column
-- written with GitHub's casing would hide a member's rows from the other side. Lowercase every
-- column that holds a login. Where a lowercase twin already exists under a unique key, the row is
-- skipped (or, for duplicates that mean the same thing, dropped; usage is added into the twin).

UPDATE OR IGNORE admins SET login = lower(login) WHERE login != lower(login);
DELETE FROM admins WHERE login != lower(login);
UPDATE admins SET added_by = lower(added_by) WHERE added_by != lower(added_by);

UPDATE audit_log SET login = lower(login) WHERE login != lower(login);

UPDATE gpt_projects SET owner = lower(owner) WHERE owner != lower(owner);
-- (owner, lab_name) is unique: a lab chat whose name the lowercase owner already uses stays put.
UPDATE OR IGNORE gpt_conversations SET owner = lower(owner) WHERE owner != lower(owner);
UPDATE gpt_files SET owner = lower(owner) WHERE owner != lower(owner);
UPDATE gpt_skills SET owner = lower(owner) WHERE owner != lower(owner);

UPDATE OR IGNORE gpt_shares SET grantee = lower(grantee) WHERE grantee != lower(grantee);
DELETE FROM gpt_shares WHERE grantee != lower(grantee);
UPDATE gpt_shares SET shared_by = lower(shared_by) WHERE shared_by != lower(shared_by);

UPDATE OR IGNORE gpt_budgets SET login = lower(login) WHERE login != lower(login);

INSERT INTO gpt_usage (login, month, input, output, cache_read, cache_write, cost_usd)
  SELECT lower(login), month, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write),
         SUM(cost_usd)
  FROM gpt_usage WHERE login != lower(login) GROUP BY lower(login), month
  ON CONFLICT (login, month) DO UPDATE SET input = input + excluded.input,
    output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
    cache_write = cache_write + excluded.cache_write, cost_usd = cost_usd + excluded.cost_usd;
DELETE FROM gpt_usage WHERE login != lower(login);

-- Both key on login COLLATE NOCASE, so two casings of one login can't both be there.
UPDATE profiles SET login = lower(login) WHERE login != lower(login) COLLATE BINARY;
UPDATE profile_pending SET login = lower(login) WHERE login != lower(login) COLLATE BINARY;

UPDATE devices SET created_by = lower(created_by) WHERE created_by != lower(created_by);
UPDATE enrollment_tokens SET created_by = lower(created_by) WHERE created_by != lower(created_by);
UPDATE experiments SET created_by = lower(created_by) WHERE created_by != lower(created_by);
UPDATE commands SET requested_by = lower(requested_by) WHERE requested_by != lower(requested_by);
UPDATE workflows SET updated_by = lower(updated_by) WHERE updated_by != lower(updated_by);
UPDATE events SET updated_by = lower(updated_by) WHERE updated_by != lower(updated_by);

INSERT OR IGNORE INTO migrations (id) VALUES ('lowercase-logins');
