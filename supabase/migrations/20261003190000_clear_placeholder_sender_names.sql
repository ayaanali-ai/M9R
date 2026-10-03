-- An older version saved the words 'You' / 'Me' as the sender name of human messages, so every other member of a shared
-- workspace saw 'You' on a message somebody else sent. Clearing them lets the dashboard resolve the real name from the
-- sender's profile (and keeps it current if they rename). Agent messages and real names are untouched.
update public.conversation_messages
set sender_display_name = null
where sender_user_id is not null
  and lower(btrim(sender_display_name)) in ('you', 'me');
