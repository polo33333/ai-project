-- Allow weekly limits (Monday–Sunday, Vietnam time) alongside daily and monthly ones.
ALTER TABLE app.ai_usage_limits DROP CONSTRAINT ai_usage_limits_period_check;
ALTER TABLE app.ai_usage_limits ADD CONSTRAINT ai_usage_limits_period_check CHECK (period IN ('day','week','month'));
