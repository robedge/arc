-- Setup overhead became one suggestion per session with a new trigger (spec 008 amendment 2026-10-20).
-- Open ones of the old rules (one per agent, or the 30%-share one for the session) are removed; the new rule
-- creates its own at the next turn. Dismissed rows stay, so a dismissed one is still never recreated.
DELETE FROM `usage_suggestions` WHERE `kind` = 'setup_overhead' AND `dismissed_at` IS NULL;
