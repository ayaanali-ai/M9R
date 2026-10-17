-- The waitlist table never had a name column; the homepage dialog and /api/waitlist
-- route both collect and forward "name", but this worker silently dropped it before
-- reaching D1. Add it so a real name can be stored and shown in the owner notification.
ALTER TABLE waitlist ADD COLUMN name TEXT;
