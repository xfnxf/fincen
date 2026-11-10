use sqlx::PgPool;
use std::fmt::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::MarketQuery;

pub struct ForumSection {
    pub name: String,
    pub forums: Vec<Forum>,
}

pub struct Forum {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub is_market: bool,
    pub thread_count: i64,
    pub reply_count: i64,
    pub latest: Option<Latest>,
}

pub struct Latest {
    pub id: i64,
    pub label: String,
    pub time: String,
    pub user: String,
}

pub struct Home {
    pub recent: Vec<Listing>,
    pub sold: Vec<Listing>,
    pub traders: Vec<Member>,
    pub online: Vec<Member>,
    pub stats: Stats,
}

pub struct Stats {
    pub listings: i64,
    pub threads: i64,
    pub posts: i64,
    pub users: i64,
    pub newest: Option<String>,
}

pub struct Member {
    pub username: String,
    pub role: String,
    pub rep: i64,
}

impl Member {
    pub fn signed_rep(&self) -> String {
        format!("{:+}", self.rep)
    }
}

pub struct Listing {
    pub id: i64,
    pub handle: String,
    pub title: String,
    pub forum_slug: String,
    pub forum_name: String,
    pub listing_type: String,
    pub status: String,
    pub author: String,
    pub staff: bool,
    pub reply_count: i64,
    pub price: String,
    pub last_post: String,
}

impl Listing {
    pub fn tag(&self) -> &'static str {
        match self.listing_type.as_str() {
            "buy" => "WTB",
            "sell" => "WTS",
            _ => "",
        }
    }
}

struct ListingRow {
    id: i64,
    handle: Option<String>,
    title: String,
    forum_slug: String,
    forum_name: String,
    listing_type: Option<String>,
    status: String,
    author: String,
    role: String,
    reply_count: i64,
    price_cents: Option<i64>,
    last_post_at: i64,
}

impl From<ListingRow> for Listing {
    fn from(row: ListingRow) -> Self {
        Self {
            id: row.id,
            handle: row.handle.unwrap_or_default(),
            title: row.title,
            forum_slug: row.forum_slug,
            forum_name: row.forum_name,
            listing_type: row.listing_type.unwrap_or_default(),
            status: row.status,
            author: row.author,
            staff: row.role != "member",
            reply_count: row.reply_count,
            price: money(row.price_cents),
            last_post: age(row.last_post_at),
        }
    }
}

fn money(price: Option<i64>) -> String {
    let Some(cents) = price else {
        return "Offers".to_owned();
    };
    let amount = cents.unsigned_abs();
    let digits = (amount / 100).to_string();
    let mut formatted = if cents < 0 {
        "-$".to_owned()
    } else {
        "$".to_owned()
    };
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            formatted.push(',');
        }
        formatted.push(digit);
    }
    if amount % 100 != 0 {
        write!(formatted, ".{:02}", amount % 100).unwrap();
    }
    formatted
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn age(timestamp: i64) -> String {
    let minutes = now_ms().saturating_sub(timestamp) / 60_000;
    match minutes {
        ..=0 => "just now".into(),
        1..=59 => format!("{minutes} min ago"),
        60..=1439 => format!("{} hr ago", minutes / 60),
        _ => format!(
            "{} day{} ago",
            minutes / 1440,
            if minutes / 1440 == 1 { "" } else { "s" }
        ),
    }
}

pub async fn sections(db: &PgPool) -> Result<Vec<ForumSection>, sqlx::Error> {
    let rows = sqlx::query_file!("sql/forums.sql").fetch_all(db).await?;
    let mut sections: Vec<ForumSection> = Vec::new();
    for row in rows {
        let index = match sections
            .iter()
            .position(|section| section.name == row.section)
        {
            Some(index) => index,
            None => {
                sections.push(ForumSection {
                    name: row.section,
                    forums: Vec::new(),
                });
                sections.len() - 1
            }
        };
        sections[index].forums.push(Forum {
            slug: row.slug,
            name: row.name,
            description: row.description,
            is_market: row.is_market == 1,
            thread_count: row.thread_count,
            reply_count: row.reply_count,
            latest: row.latest_id.map(|id| Latest {
                id,
                label: row
                    .latest_handle
                    .map(|handle| format!("@{handle}"))
                    .unwrap_or_else(|| {
                        row.latest_title
                            .unwrap_or_default()
                            .chars()
                            .take(32)
                            .collect()
                    }),
                time: age(row.latest_at.unwrap_or_default()),
                user: row.latest_user.unwrap_or_default(),
            }),
        });
    }
    Ok(sections)
}

pub async fn home(db: &PgPool) -> Result<Home, sqlx::Error> {
    let cutoff = now_ms() - 600_000;
    let (recent, sold, traders, online, stats) = tokio::try_join!(
        sqlx::query_file_as!(ListingRow, "sql/home_listings.sql", "open").fetch_all(db),
        sqlx::query_file_as!(ListingRow, "sql/home_listings.sql", "sold").fetch_all(db),
        sqlx::query_as!(
            Member,
            r#"
            SELECT u.username, u.role, sum(v.rating)::bigint AS "rep!"
            FROM users u JOIN vouches v ON v.to_id = u.id
            WHERE u.banned = 0 GROUP BY u.id HAVING sum(v.rating) > 0
            ORDER BY sum(v.rating) DESC, u.id LIMIT 6
        "#
        )
        .fetch_all(db),
        sqlx::query_as!(
            Member,
            r#"
            SELECT username, role, 0::bigint AS "rep!"
            FROM users WHERE last_seen > $1 AND banned = 0
            ORDER BY last_seen DESC LIMIT 40
        "#,
            cutoff
        )
        .fetch_all(db),
        sqlx::query_as!(
            Stats,
            r#"
            SELECT
              (SELECT count(*) FROM threads t JOIN forums f ON f.id = t.forum_id
               WHERE t.deleted = 0 AND f.is_market = 1 AND t.status = 'open') AS "listings!",
              (SELECT count(*) FROM threads WHERE deleted = 0) AS "threads!",
              (SELECT count(*) FROM posts WHERE deleted = 0) AS "posts!",
              (SELECT count(*) FROM users) AS "users!",
              (SELECT username FROM users ORDER BY id DESC LIMIT 1) AS "newest?"
        "#
        )
        .fetch_one(db),
    )?;
    Ok(Home {
        recent: recent.into_iter().map(Listing::from).collect(),
        sold: sold.into_iter().map(Listing::from).collect(),
        traders,
        online,
        stats,
    })
}

pub struct MarketFilter {
    pub q: String,
    pub platform: String,
    pub listing_type: String,
    pub status: String,
    pub max: String,
    pub sort: String,
    pub stock: bool,
    page: i64,
}

impl From<MarketQuery> for MarketFilter {
    fn from(input: MarketQuery) -> Self {
        fn clean(input: Option<String>, limit: usize) -> String {
            input
                .as_deref()
                .unwrap_or("")
                .trim()
                .chars()
                .filter(|&c| c != '\0')
                .take(limit)
                .collect()
        }
        fn choice(input: Option<String>, choices: &[&str], default: &str) -> String {
            input
                .filter(|value| choices.contains(&value.as_str()))
                .unwrap_or_else(|| default.to_owned())
        }
        Self {
            q: clean(input.q, 64).trim_start_matches('@').to_owned(),
            platform: clean(input.platform, 32),
            listing_type: choice(input.listing_type, &["buy", "sell"], ""),
            status: choice(input.status, &["open", "sold", "closed", "all"], "open"),
            max: clean(input.max, 12),
            sort: choice(input.sort, &["new", "low", "high"], "new"),
            stock: input.stock.as_deref() == Some("1"),
            page: input.page.and_then(|p| p.parse().ok()).unwrap_or(1).max(1),
        }
    }
}

impl MarketFilter {
    pub fn is_default(&self) -> bool {
        self.q.is_empty()
            && self.platform.is_empty()
            && self.listing_type.is_empty()
            && self.status == "open"
            && self.max.is_empty()
            && self.sort == "new"
            && !self.stock
    }

    pub fn href(&self, page: i64) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in [
            ("q", self.q.as_str()),
            ("platform", &self.platform),
            ("type", &self.listing_type),
            ("status", &self.status),
            ("max", &self.max),
            ("sort", &self.sort),
            ("stock", if self.stock { "1" } else { "" }),
        ] {
            if !value.is_empty() {
                query.append_pair(key, value);
            }
        }
        query.append_pair("page", &page.to_string());
        format!("/market?{}", query.finish())
    }
}

pub struct MarketResults {
    pub listings: Vec<Listing>,
    pub total: i64,
    pub page: i64,
    pub pages: i64,
}

pub async fn market(db: &PgPool, filter: &MarketFilter) -> Result<MarketResults, sqlx::Error> {
    let max_price = filter
        .max
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| (n * 100.0).round() as i64);
    let rows = sqlx::query_file!(
        "sql/market.sql",
        filter.q,
        filter.platform,
        filter.listing_type,
        filter.stock,
        filter.status,
        max_price,
        filter.sort,
        filter.page
    )
    .fetch_all(db)
    .await?;
    let meta = &rows[0]; // The metadata CTE supplies one row even for empty results.
    let (total, page, pages) = (meta.total, meta.page, meta.pages);
    let listings = rows
        .into_iter()
        .filter_map(|row| {
            Some(Listing::from(ListingRow {
                id: row.id?,
                handle: row.handle,
                title: row.title?,
                forum_slug: row.forum_slug?,
                forum_name: row.forum_name?,
                listing_type: row.listing_type,
                status: row.status?,
                author: row.author?,
                role: row.role?,
                reply_count: row.reply_count?,
                price_cents: row.price_cents,
                last_post_at: row.last_post_at?,
            }))
        })
        .collect();
    Ok(MarketResults {
        listings,
        total,
        page,
        pages,
    })
}
