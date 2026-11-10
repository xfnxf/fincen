SELECT t.id, t.handle, t.title, f.slug AS forum_slug, f.name AS forum_name,
       t.listing_type, t.status, u.username AS author, u.role, t.reply_count,
       t.price_cents, t.last_post_at
FROM threads t
JOIN forums f ON f.id = t.forum_id
JOIN users u ON u.id = t.user_id
WHERE t.deleted = 0 AND f.is_market = 1 AND t.status = $1
ORDER BY CASE WHEN $1 = 'sold' THEN COALESCE(t.status_at, t.created_at) ELSE t.created_at END DESC, t.id DESC
LIMIT CASE WHEN $1 = 'sold' THEN 5 ELSE 8 END
