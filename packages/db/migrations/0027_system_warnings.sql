-- 0027_system_warnings: in-app system warnings (Phase 7 slice 7.2). The owner chose to see backup and background-work
-- problems inside InnPilot instead of through an outside alert service. Owner and general manager only: not a
-- "*.read" permission, so the read-everything roles (accountant, auditor) do not inherit it.
INSERT INTO permissions (code, description)
  VALUES ('system.warnings', 'See system warnings about backups and background work');
INSERT INTO role_permissions (role_code, permission_code)
  VALUES ('tenant_owner', 'system.warnings'), ('hotel_manager', 'system.warnings');
