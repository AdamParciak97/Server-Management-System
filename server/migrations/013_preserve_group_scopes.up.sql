-- Removing a last scope must never silently turn an account into a global one.
ALTER TABLE user_group_scopes DROP CONSTRAINT user_group_scopes_group_id_fkey;
ALTER TABLE user_group_scopes ADD CONSTRAINT user_group_scopes_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT;
ALTER TABLE ldap_group_mappings DROP CONSTRAINT ldap_group_mappings_group_id_fkey;
ALTER TABLE ldap_group_mappings ADD CONSTRAINT ldap_group_mappings_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT;
