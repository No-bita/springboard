# Springboard Development & Architecture Rules

## Navigation & Codebase Investigation

- **Consult Documentation First**: Before executing broad exploratory grep searches or reading multiple candidate files, ALWAYS check [PROJECT_OVERVIEW.md](file:///Users/aaryanshah/Downloads/Lekho-Edge/PROJECT_OVERVIEW.md) first. It contains the definitive system directory map, architectural flow, data models, and API route contracts.
- **Direct Targeted Access**: Use the module breakdown in `PROJECT_OVERVIEW.md` to navigate directly to the exact target file and function instead of running iterative multi-file discovery searches.
- **Maintain Documentation Parity**: Whenever architectural flows, routes, or component responsibilities change, keep `PROJECT_OVERVIEW.md` synchronized.

---

## UI & UX Guidelines

- **No Unnecessary Microcopy**: Unless explicitly required by the user or essential for accessibility, avoid adding explanatory subtext, helper labels, or decorative microcopy below headings and buttons. Keep UI elements high-leverage, clean, and direct.

---

## Deployment & Version Control

- **Dual Deployment Standard**: Whenever asked to deploy, ALWAYS:
  1. **Deploy to Cloudflare**: Run `npx wrangler deploy` in `v2/`.
  2. **Push to GitHub**: Stage, commit with clear semantic message, and run `git push origin main`.

