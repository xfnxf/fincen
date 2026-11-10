SELECT f.section, f.slug, f.name, f.description, f.is_market,
       counts.thread_count AS "thread_count!",
       counts.reply_count AS "reply_count!",
       latest.id AS "latest_id?", latest.handle AS "latest_handle?",
       latest.title AS "latest_title?", latest.last_post_at AS "latest_at?",
       latest.username AS "latest_user?"
FROM forums f
CROSS JOIN LATERAL (
    SELECT count(*) AS thread_count, COALESCE(sum(t.reply_count), 0)::bigint AS reply_count
    FROM threads t WHERE t.forum_id = f.id AND t.deleted = 0
) counts
LEFT JOIN LATERAL (
    SELECT t.id, t.handle, t.title, t.last_post_at, COALESCE(lu.username, u.username) AS username
    FROM threads t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN users lu ON lu.id = t.last_post_user_id
    WHERE t.forum_id = f.id AND t.deleted = 0
    ORDER BY t.last_post_at DESC, t.id DESC LIMIT 1
) latest ON true
ORDER BY f.position, f.id
