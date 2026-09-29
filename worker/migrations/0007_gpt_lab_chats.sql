-- The lab's AI chats (jupyterlite-ai in JupyterLab) are kept as Hafezi GPT conversations instead
-- of .chat files in the member's home. lab_name is the chat's name in the lab, one conversation
-- per name; the lab's own JSON is in R2 (gpt/lab-chats/<conversation id>.json) and gpt_messages
-- holds its text, so /gpt lists and shows it like any other chat.
ALTER TABLE gpt_conversations ADD COLUMN lab_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS gpt_conversations_lab
  ON gpt_conversations (owner, lab_name) WHERE lab_name IS NOT NULL;

INSERT OR IGNORE INTO migrations (id) VALUES ('gpt-lab-chats');
