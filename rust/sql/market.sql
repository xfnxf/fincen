WITH filtered AS (
    SELECT t.id, t.handle, t.title, f.slug AS forum_slug, f.name AS forum_name,
           t.listing_type, t.status, u.username AS author, u.role, t.reply_count,
           t.price_cents, t.last_post_at
    FROM threads t
    JOIN forums f ON f.id = t.forum_id
    JOIN users u ON u.id = t.user_id
    WHERE t.deleted = 0 AND f.is_market = 1
      AND ($1 = '' OR strpos(lower(t.handle), lower($1)) > 0 OR strpos(lower(t.title), lower($1)) > 0)
      AND ($2 = '' OR f.slug = $2)
      AND ($3 = '' OR t.listing_type = $3)
      AND (NOT $4::boolean OR (u.role <> 'member' AND t.listing_type = 'sell'))
      AND ($5 = 'all' OR t.status = $5)
      AND ($6::bigint IS NULL OR t.price_cents <= $6)
), count_rows AS (
    SELECT count(*) AS total FROM filtered
), meta AS (
    SELECT total, greatest(1, (total + 19) / 20) AS pages,
           least($8::bigint, greatest(1, (total + 19) / 20)) AS page
    FROM count_rows
)
SELECT meta.total AS "total!", meta.pages AS "pages!", meta.page AS "page!",
       p.id AS "id?", p.handle AS "handle?", p.title AS "title?",
       p.forum_slug AS "forum_slug?", p.forum_name AS "forum_name?",
       p.listing_type AS "listing_type?", p.status AS "status?",
       p.author AS "author?", p.role AS "role?", p.reply_count AS "reply_count?",
       p.price_cents AS "price_cents?", p.last_post_at AS "last_post_at?"
FROM meta LEFT JOIN LATERAL (
    SELECT * FROM filtered
    ORDER BY CASE WHEN $7 = 'low' THEN price_cents END ASC NULLS LAST,
             CASE WHEN $7 = 'high' THEN price_cents END DESC NULLS LAST,
             last_post_at DESC, id DESC
    LIMIT 20 OFFSET (meta.page - 1) * 20
) p ON true
ORDER BY CASE WHEN $7 = 'low' THEN p.price_cents END ASC NULLS LAST,
         CASE WHEN $7 = 'high' THEN p.price_cents END DESC NULLS LAST,
         p.last_post_at DESC, p.id DESC
