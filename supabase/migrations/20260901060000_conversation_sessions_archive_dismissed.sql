-- "Keep open" on a proposed archive must actually stick: without a distinct
-- dismissed marker, the idle sweep re-flagged the same session for archive
-- on the very next poll (nothing distinguished "never asked" from "human
-- said not yet"), so the button appeared to do nothing.
alter table conversation_sessions add column if not exists archive_dismissed_at timestamptz;
