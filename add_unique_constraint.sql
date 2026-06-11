-- Migration: Add unique database constraint to prevent duplicate billing cycles

-- 1. Ensure only one billing cycle can start on the same date for a household
ALTER TABLE billing_cycle_summary
ADD CONSTRAINT billing_cycle_summary_household_cycle_unique
UNIQUE (household_id, cycle_start);

-- 2. Ensure only one billing cycle with the exact start and end date can exist for a household
ALTER TABLE billing_cycle_summary
ADD CONSTRAINT billing_cycle_summary_household_cycle_range_unique
UNIQUE (household_id, cycle_start, cycle_end);
