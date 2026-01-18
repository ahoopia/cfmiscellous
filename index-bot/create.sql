-- 1. 主表：明确 ID
-- CREATE TABLE IF NOT EXISTS search_index (
--    id INTEGER PRIMARY KEY, -- 这里对应 Telegram 的 message_id
--    chat_id TEXT,
--   content TEXT
-- );

-- 2. 虚表：不映射外部内容，简单直接
CREATE VIRTUAL TABLE IF NOT EXISTS search_index_fts USING fts5(
    id,
    content,
    tokenize = 'unicode61'
);
