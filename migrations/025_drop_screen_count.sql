-- Migration 025: Drop screen_count column from theaters
-- Lands ADR 0002 ("Drop screen_count — it's not a domain attribute").
-- The column was historically scraped and displayed but never queried; the
-- historical values are intentionally discarded per the ADR.

ALTER TABLE theaters DROP COLUMN IF EXISTS screen_count;
