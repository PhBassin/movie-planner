-- Admin Member management (issue #65): a dedicated `members` permission
-- category for the Staff surface over the Member base (list / view / suspend
-- / reinstate / delete). Deliberately NOT granted to the operator role —
-- Members are manageable by Admins only and the operator workflow is
-- unchanged. The permissions are already part of the docker/init.sql
-- baseline; this numbered migration carries them to databases initialized
-- before the baseline gained them. Idempotent, like every migration here.

BEGIN;

INSERT INTO permissions (name, description, category) VALUES
  ('members:list',               'List members',                             'members'),
  ('members:read',               'View member details',                      'members'),
  ('members:update',             'Suspend and reinstate members',            'members'),
  ('members:delete',             'Delete members',                           'members')
ON CONFLICT (name) DO NOTHING;

-- Admin keeps every permission (the is_system bypass in code makes the
-- explicit grants self-describing for tooling; re-running the grant here
-- carries the new category to existing databases).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.name IN (
  'members:list', 'members:read', 'members:update', 'members:delete'
)
WHERE r.name = 'admin' AND r.is_system = true
ON CONFLICT DO NOTHING;

-- French/English label for the roles UI category grouping.
INSERT INTO permission_category_labels (category_key, label_en, label_fr)
VALUES ('members', 'Members', 'Membres')
ON CONFLICT (category_key) DO NOTHING;

COMMIT;
