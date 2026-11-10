# Fincen: Hermes theme refinements

The original Hermes design is authoritative: ink navy, electric blue, Antonio display type, Barlow Condensed labels, JetBrains Mono details, square surfaces, centred FINCEN wordmark, three-line headline, and sunburst. Do not replace this visual identity.

## Implemented

- Shared 4px spacing rhythm, 24px content gutters between columns, 20px desktop cell padding, 16px mobile cell padding. Original 1120px outer container and hero composition retained.
- Fixed forum table columns: 42/10/10/38 percent on desktop; responsive two-column proportions with counts hidden on smaller screens.
- Identical header/body/footer container edges and mathematically centred wordmark. Navigation spacing and search flex sizing prevent crowding.
- Consistent button heights, table spacing, sidebar rows, and tabular prices.
- Original electric blue emphasizes the existing Marketplace heading and featured listing hover states. No new hero, sections, palette, or promotional copy.
- Dark/light themes retain their original palettes with more readable muted text and shared white-on-blue tokens. Neutral sold badges avoid conveying an error.
- Visible keyboard focus, accessible navigation/search names, email-field theme styling, and long-text wrapping.

## Validation

Desktop DOM geometry: logo midpoint equals content midpoint; all four forum tables have identical column coordinates. Mobile checked at 390px with no page horizontal overflow. Light theme persists when moving from home to market. Original headline and sunburst remain present. All 32 EJS templates compile; home, market, forum, listing, login, and registration return HTTP 200.

The retired `public/design-system.css` is not loaded and is not the design reference. The current implementation lives in `public/style.css` under the Hermes theme refinement comment.

## Next phase

Backend migration is still planned, not implemented: see RUST_MIGRATION.md and MIGRATION_ROUTES.csv. Preserve this appearance when moving to Askama/Tailwind. No VPS/domain has been provisioned.
