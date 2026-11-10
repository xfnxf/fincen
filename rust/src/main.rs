mod forum;

use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use askama::Template;
use axum::{
    Router,
    extract::{OriginalUri, Query, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
};
use serde::Deserialize;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use forum::{ForumSection, Home, Listing, MarketFilter};

#[derive(Clone)]
struct AppState {
    db: PgPool,
}

struct Page {
    theme: &'static str,
    sections: Vec<ForumSection>,
    search: String,
    market: bool,
    rays: Vec<Ray>,
}

#[derive(Template)]
#[template(path = "home.html")]
struct HomePage {
    page: Page,
    home: Home,
}

#[derive(Template)]
#[template(path = "market.html")]
struct MarketPage {
    page: Page,
    filters: MarketFilter,
    featured: Vec<Listing>,
    listings: Vec<Listing>,
    total: i64,
    platforms: usize,
    prev: Option<String>,
    next: Option<String>,
}

struct Ray {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
}

fn sunburst() -> Vec<Ray> {
    (0..120)
        .map(|i| {
            let a = f64::from(i) * std::f64::consts::PI / 60.0;
            let (sin, cos) = a.sin_cos();
            let radius = if i % 2 == 0 { 96.0 } else { 118.0 };
            Ray {
                x1: 125.0 + cos * 50.0,
                y1: 125.0 + sin * 50.0,
                x2: 125.0 + cos * radius,
                y2: 125.0 + sin * radius,
            }
        })
        .collect()
}

fn theme(headers: &HeaderMap) -> &'static str {
    let light = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|cookie| cookie.to_str().ok())
        .flat_map(|cookie| cookie.split(';'))
        .any(|part| part.trim() == "theme=light");
    if light { "light" } else { "dark" }
}

fn render(template: impl Template) -> Result<Html<String>, AppError> {
    Ok(Html(template.render()?))
}

async fn home(State(state): State<AppState>, headers: HeaderMap) -> Result<Html<String>, AppError> {
    let (sections, home) = tokio::try_join!(forum::sections(&state.db), forum::home(&state.db))?;
    render(HomePage {
        page: Page {
            theme: theme(&headers),
            sections,
            search: String::new(),
            market: false,
            rays: sunburst(),
        },
        home,
    })
}

async fn market(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<MarketQuery>,
) -> Result<Html<String>, AppError> {
    let filters = MarketFilter::from(input);
    let (sections, results) = tokio::try_join!(
        forum::sections(&state.db),
        forum::market(&state.db, &filters)
    )?;
    let platforms = sections
        .iter()
        .flat_map(|section| &section.forums)
        .filter(|forum| forum.is_market)
        .count();
    let mut listings = results.listings;
    let featured = if filters.is_default() && results.page == 1 {
        listings.drain(..listings.len().min(3)).collect()
    } else {
        Vec::new()
    };
    let prev = (results.page > 1).then(|| filters.href(results.page - 1));
    let next = (results.page < results.pages).then(|| filters.href(results.page + 1));
    render(MarketPage {
        page: Page {
            theme: theme(&headers),
            sections,
            search: filters.q.clone(),
            market: true,
            rays: sunburst(),
        },
        filters,
        featured,
        listings,
        total: results.total,
        platforms,
        prev,
        next,
    })
}

#[derive(Default, Deserialize)]
struct MarketQuery {
    q: Option<String>,
    platform: Option<String>,
    #[serde(rename = "type")]
    listing_type: Option<String>,
    status: Option<String>,
    max: Option<String>,
    sort: Option<String>,
    stock: Option<String>,
    page: Option<String>,
}

async fn ready(State(state): State<AppState>) -> Result<&'static str, AppError> {
    sqlx::query!("SELECT 1 AS ready")
        .fetch_one(&state.db)
        .await?;
    Ok("ok")
}

async fn legacy_preview(method: Method, OriginalUri(uri): OriginalUri) -> Response {
    if !matches!(method, Method::GET | Method::HEAD) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    // The preview binds to loopback and only redirects to the fixed legacy origin.
    let path = uri.path_and_query().map_or("/", |p| p.as_str());
    Redirect::temporary(&format!("http://localhost:3001{path}")).into_response()
}

struct AppError;

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "database request failed");
        Self
    }
}

impl From<askama::Error> for AppError {
    fn from(error: askama::Error) -> Self {
        tracing::error!(%error, "page render failed");
        Self
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "The forum preview could not load this page.",
        )
            .into_response()
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let db = PgPoolOptions::new()
        .max_connections(8)
        .connect(&env::var("DATABASE_URL")?)
        .await?;
    if env::args().any(|arg| arg == "--migrate-only") {
        sqlx::migrate!().run(&db).await?;
        return Ok(());
    }
    let public =
        PathBuf::from(env::var_os("FINCEN_PUBLIC_DIR").unwrap_or_else(|| "../public".into()));
    let app = Router::new()
        .route("/", get(home))
        .route("/market", get(market))
        .route("/healthz", get(ready))
        .route_service("/style.css", ServeFile::new(public.join("style.css")))
        .route_service("/app.js", ServeFile::new(public.join("app.js")))
        .nest_service("/fonts", ServeDir::new(public.join("fonts")))
        .fallback(legacy_preview)
        .layer(TraceLayer::new_for_http())
        .with_state(AppState { db });
    let port = env::var("FINCEN_PREVIEW_PORT")
        .unwrap_or_else(|_| "3002".into())
        .parse()?;
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("Fincen Rust preview at http://localhost:{port}/");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
