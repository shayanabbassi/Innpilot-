-- Phase 6 slice 6.1: account recovery (PRD §8 "password recovery"; D18: manager-issued resets at the pilot).
-- A manager issues a one-time temporary password for a staff member, handed over in person. It works for a limited
-- time and only to choose a new password: the session can do nothing else until the password is changed.

ALTER TABLE users
  ADD COLUMN password_change_required boolean NOT NULL DEFAULT false,
  -- When a temporary password stops working (null for a password the user chose).
  ADD COLUMN password_expires_at timestamptz,
  ADD CONSTRAINT users_temporary_password CHECK (password_expires_at IS NULL OR password_change_required);
