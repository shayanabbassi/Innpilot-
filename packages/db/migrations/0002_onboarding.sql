-- 0002_onboarding: track when a property's setup wizard was finished.
-- NULL means onboarding is still in progress; the web app sends managers to the wizard until it is set.

ALTER TABLE properties ADD COLUMN onboarding_completed_at timestamptz;

-- Properties that existed before this migration were configured by hand; treat them as onboarded.
UPDATE properties SET onboarding_completed_at = created_at WHERE onboarding_completed_at IS NULL;
