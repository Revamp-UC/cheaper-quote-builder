# Cheaper Quote Builder

Internal tool for UrbanCompany's interior panel sales team.

When a customer hesitates on price, the agent uploads their existing UC quotation PDF to this tool. The tool automatically reads all the panels, quantities, and totals from the PDF using free in-browser OCR (no API key required), then finds visually similar but cheaper alternatives from our panel catalog. It then generates every possible cheaper quote combination using permutations & combinations — with taxes, discounts, and wall area coverage recomputed precisely to match the original quote logic.

**Live site:** `cheaper-quote-builder.onrender.com`
**Access PIN:** `1402`
**Repo:** `github.com/vaibhavmishraint-sketch/IST` (private)

---

## Table of Contents

1. [What It Does — User Journey](#1-what-it-does--user-journey)
2. [Pages & Navigation](#2-pages--navigation)
3. [Tech Stack](#3-tech-stack)
4. [Why OCR Instead of Text Extraction](#4-why-ocr-instead-of-text-extraction)
5. [How Visual Similarity Works](#5-how-visual-similarity-works)
6. [Pricing & Quote Math](#6-pricing--quote-math)
7. [Permutations & Combinations (PnC) Engine](#7-permutations--combinations-pnc-engine)
8. [OOS (Out of Stock) Integration](#8-oos-out-of-stock-integration)
9. [Daily Auto-Refresh Pipeline](#9-daily-auto-refresh-pipeline)
10. [Repository Structure](#10-repository-structure)
11. [Data Files — Formats & Schemas](#11-data-files--formats--schemas)
12. [Apps Script (Google Sheet)](#12-apps-script-google-sheet)
13. [GitHub Actions Workflow](#13-github-actions-workflow)
14. [Quote Builder Logic — Step by Step](#14-quote-builder-logic--step-by-step)
15. [Catalog Logic](#15-catalog-logic)
16. [PIN Gate](#16-pin-gate)
17. [Running Locally](#17-running-locally)
18. [Deploying to Render](#18-deploying-to-render)
19. [How to Update the Catalog Data](#19-how-to-update-the-catalog-data)
20. [Troubleshooting](#20-troubleshooting)
21. [Security & Secrets](#21-security--secrets)

---

## 1. What It Does — User Journey

### The Problem
A customer receives a UC quotation (typically ₹25,000–₹80,000 for wall panels) and feels it's too expensive. The agent needs to offer cheaper alternatives quickly, but finding visually similar panels manually across 200+ SKUs is slow and error-prone.

### The Solution — Step by Step

**Step 1 — Open the tool**
Agent opens `cheaper-quote-builder.onrender.com`, enters PIN `1402`, selects the customer's city.

**Step 2 — Upload the customer's PDF**
Agent uploads the original UC quotation PDF. The tool renders every page to canvas using pdf.js, then runs Tesseract.js OCR on each canvas image to extract all text. This is done fully in the browser — no data ever leaves the device.

**Step 3 — Review extracted data**
The tool shows the agent a side-by-side view:
- Left: the actual PDF (for visual reference)
- Right: an editable table with all the extracted panels, quantities, and quote totals

The agent can correct any OCR errors, fix panel matches, edit quantities, or add panels manually before proceeding.

**Step 4 — Generate cheaper quotes**
The agent clicks "Generate Quotes →". The tool:
- Looks up cheaper similar alternatives for each panel
- Recomputes quantity required to cover the same wall area (panel sizes differ)
- Generates every possible combination of swaps
- Filters out any combination that doesn't actually save money (after taxes + discount slab recalculation)
- Displays the remaining quotes sorted by savings

**Step 5 — Share with customer**
Each quote card shows: which panels were swapped, new total, ₹ saved, similarity scores. The agent can discuss each option with the customer in the site visit itself.

---

## 2. Pages & Navigation

| Page | URL | Purpose |
|------|-----|---------|
| City Selector | `/index.html` | PIN gate → choose city |
| Quote Builder | `/quote.html?city=delhi` | Upload PDF → review → generate cheaper quotes |
| Catalog | `/catalog.html?city=delhi` | Browse all panels, see their cheaper alternatives |

**Supported cities:** `delhi`, `mumbai`, `bengaluru`, `hyderabad`

City is passed as a URL query parameter (`?city=`). Both Quote Builder and Catalog read this parameter on load and use it to fetch the right city's data and prices.

**Topbar layout on Quote Builder:**
- `← City` (left) — returns to city selector
- `⬆ Upload Quote` (right) — opens file picker
- `🌐 Catalog` (right) — opens catalog for the same city

---

## 3. Tech Stack

| Component | What We Use | Why |
|-----------|-------------|-----|
| PDF rendering | pdf.js v3.11.174 (vendored) | Renders PDF pages to HTML canvas — works offline, no server needed |
| OCR | Tesseract.js v5.1.1 (vendored) | Free in-browser OCR, no API key, no external call |
| Catalog data | `assets/data/{city}.json` | Pre-built per-city JSONs, fast to load |
| Similarity data | `assets/data/similarity_new.json` | 196 curated panel pairs with % scores |
| Hosting | Render (Static Site) | Free tier, auto-deploys from GitHub |
| Data sync | Google Apps Script | Reads Google Sheet, updates master.json via GitHub API |
| CI/CD | GitHub Actions | Rebuilds city JSONs on every master.json change |
| Styles | Plain CSS (dark theme) | No framework, fast load |

**No backend, no database, no API keys required in production.** Everything runs in the browser. The only server is Render serving static files.

The one exception: Google Apps Script runs server-side on Google's infrastructure, but that only updates data files — it doesn't serve the website.

---

## 4. Why OCR Instead of Text Extraction

UC quotation PDFs use **Identity-H CID fonts** (a type of embedded font used in Unicode PDFs). These fonts embed glyphs as shapes without mapping them back to Unicode characters. This means:

- Standard PDF text extraction tools (like pdf.js's built-in `getTextContent()`) return empty strings or garbage
- Even tools like `pdftotext` or Adobe's own extraction fail

**Solution:** Render each PDF page to a canvas image (pdf.js handles this correctly, it only needs the visual glyph shapes) → run Tesseract.js OCR on the canvas image → parse the OCR output as plain text.

This is slower than text extraction (~5–20 seconds depending on PDF length) but works reliably on all UC quotes.

**OCR quirk — the ₹ sign:** Tesseract frequently misreads `₹` as a digit (usually `7` or `1`). This corrupts number parsing. We fix this with a **₹ reconciliation step**: we know that `Subtotal + Taxes − Discount = Grand Total`, so we back-calculate which parsed numbers are correct and which contain the misread `₹` prefix.

---

## 5. How Visual Similarity Works

### Background
Visual similarity between wall panels cannot be done with keyword matching — "WPC Ceramic" and "PVC Textured" might look nearly identical but have completely different names. We need image-based similarity.

### 4-Signal Scoring System

Each pair of panels is scored on a 0–100 scale using four signals:

| Signal | Weight | What it measures |
|--------|--------|-----------------|
| **DINOv2** (Facebook's self-supervised vision model) | 35% | Deep visual features — pattern, grain, surface texture, geometric structure |
| **Lab hue-aware color distance** | 35% | Color match in CIELAB color space, which is perceptually uniform (a ΔE=5 looks the same whether you're matching beige or teal) |
| **CLIP** (OpenAI's vision-language model) | 10% | Semantic look — would a human describe both panels similarly? Catches cases where DINOv2 texture is similar but the overall vibe is different |
| **AI Judge (Claude)** | 20% | Final pass: "If a customer chose Panel A, would they accept Panel B as a look-alike?" — corrects edge cases that the automated signals miss |

**Cutoff: ≥70%** — panels below this threshold are too visually different to offer as alternatives.

**Score badges in catalog:**
- Green = ≥85% (high confidence, very close match)
- Yellow = 70–84% (moderate confidence, still acceptable)

### Similarity Source
The similarity data lives in `assets/data/similarity_new.json`. This was curated from a manual review of 196 SKUs by examining panel images and validating the automated scores. It is a **static file** — it does not change daily. Only update it when new panels are added to the catalog or when scores need correction.

---

## 6. Pricing & Quote Math

This section is critical. Every alternative quote must be mathematically consistent with how UC quotes work, or agents will face questions from customers about totals not adding up.

### Variables

| Symbol | Meaning |
|--------|---------|
| S0 | Original subtotal (from PDF) |
| T0 | Original taxes & fees (from PDF) |
| D0 | Original discount (from PDF) |
| G0 | Original grand total (from PDF) |
| saving | Total ₹ saved from panel swaps |
| S1 | New subtotal |
| T1 | New taxes |
| D1 | New discount |
| G1 | New grand total |

### Formula

```
S1 = S0 − saving

T1 = round((T0 / S0) × S1)        ← same effective tax rate as original

                    ┌ 8%   if S1 ≥ ₹25,000
d  = discount rate =│ 5%   if S1 ≥ ₹15,000
                    └ 0%   otherwise

D1 = round(d × S1)

G1 = S1 + T1 − D1

savedVsOrig = G0 − G1             ← shown as "₹ saved" on each quote card
```

### Quantity Recompute

When the alternative panel has different dimensions than the original, you need more or fewer panels to cover the same wall area.

```
origArea = origPanel.L_ft × (origPanel.W_in / 12)     ← in sq.ft
altArea  = altPanel.L_ft  × (altPanel.W_in  / 12)

qtyAlt = ceil(qtyOrig × origArea / altArea)
```

Quantity always rounds **up** (ceil) — we never under-cover a wall. The cost delta for this panel:

```
origCost = qtyOrig × origPanel.perPanel
altCost  = qtyAlt  × altPanel.perPanel
saving   = origCost − altCost
```

A swap is only eligible if `saving > 0` — i.e., even after accounting for the possibility of needing more panels (more qty), the alternative is still cheaper in total.

### Discount Slab Trap

This is a subtle edge case. A swap might cross a discount slab boundary:

- Original: S0 = ₹25,100 → 8% discount applied
- After swap: S1 = ₹24,900 → drops to 5% discount

In this case, despite the panels being cheaper, the loss of discount makes the total **higher** than the original. These combinations are filtered out by the `savedVsOrig > 0` check at the combination level.

---

## 7. Permutations & Combinations (PnC) Engine

### The Problem It Solves

If a quote has 3 panels and each has 2 cheaper alternatives, there are:
- 3 single-panel swaps (swap only one panel at a time)
- 3 two-panel swaps (swap any two panels)
- 1 three-panel swap (swap all three)
- 2 × 2 × 2 = 8 variations if we pick the best alt per panel

The agent needs to see all meaningful combinations ranked by savings, not just "swap everything."

### How It Works

**True Cartesian product:**
For each replaceable panel, we build a list of its eligible cheaper swaps. The engine does a recursive Cartesian product across all panels:

```
Panel A: [A1, A2]    (2 cheaper alts)
Panel B: [B1]        (1 cheaper alt)
Panel C: [C1, C2]   (2 cheaper alts)

Combinations:
  [origA, origB, origC]   ← baseline (not shown)
  [A1,    origB, origC]
  [A2,    origB, origC]
  [origA, B1,   origC]
  [origA, origB, C1  ]
  [origA, origB, C2  ]
  [A1,    B1,   origC]
  [A1,    origB, C1  ]
  ... (all combinations)
```

**Cap:** Maximum 100 combinations are generated. Beyond this, the output is deduped and capped — real quotes rarely hit this limit.

**Dedup:** Combinations are keyed by `sorted(panel_code→alt_code)` pairs. If two paths produce the same physical swap, only one is kept.

**Filter:** Only combinations where `savedVsOrig > 0` are shown. This eliminates:
- Swaps that cost more after area recompute
- Swaps that cross a discount slab boundary and become net-more-expensive

**Sort:** Sorted by `savedVsOrig` descending — biggest savings first.

**"No cheaper option" message:** If all alternatives for every panel cost more after area recompute and discount adjustment, a yellow warning note is shown explaining why no quotes are available. It distinguishes between:
- "None of your panels have a look-alike in the catalog" (no similarity data for those SKUs)
- "All visually similar panels cost more after adjusting for wall area coverage" (alternates exist but aren't cheaper)

---

## 8. OOS (Out of Stock) Integration

### What OOS Means

A panel marked OOS (Out of Stock) for a city means it cannot be ordered in that city today. OOS status can change daily — a panel might be OOS on Monday and back in stock Tuesday.

### How OOS Data Flows

```
Agent marks panel as OOS in Google Sheet (OOS tab)
        ↓  Apps Script runs at 9 AM
  master.json updated: panel.oos.delhi = true
        ↓  GitHub Actions triggers
  build_cities.py runs
        ↓
  delhi.json rebuilt — OOS panel excluded from alternatives for all panels
  OOS panel's own entry: oos: true (still appears in catalog)
        ↓
  Catalog shows ● OOS Today badge on that panel
  Quote builder never suggests it as an alternative
```

### Google Sheet OOS Tab Structure

The `OOS` sheet has:
- Row 1: header (`SKU Code` in each column)
- Rows 2+: one SKU per row

| Column A | Column B | Column C | Column D |
|----------|----------|----------|----------|
| Delhi OOS SKUs | Mumbai OOS SKUs | Bengaluru OOS SKUs | Hyderabad OOS SKUs |

### Rules

1. OOS panels are **excluded as alternatives** in all cities where they are OOS (even if the main panel being quoted is in stock)
2. OOS panels **still appear in the catalog** as main panels with the OOS badge — they might come back
3. OOS is **city-specific**: OOS in Delhi ≠ OOS in Mumbai. The panel can be suggested in a city where it's in stock.
4. The catalog's `● OOS Today` badge is always accurate as of the last 9 AM sync.

---

## 9. Daily Auto-Refresh Pipeline

### Full Flow

```
Google Sheet
├── Live_list tab   → which panels are live in each city + city prices
└── OOS tab         → which panels are OOS in each city
        │
        │  Apps Script (Google Apps Script, runs at 9 AM IST)
        │  - Reads both sheets
        │  - Fetches master.json from GitHub API
        │  - Updates panel.live and panel.oos for every SKU
        │  - Pushes updated master.json back via GitHub PUT /contents API
        ↓
  master.json updated on GitHub
        │
        │  GitHub Actions (refresh-cities.yml)
        │  Triggers: on push to assets/data/master.json
        │           + 9 AM IST cron fallback (3:30 UTC)
        │  - Runs build_cities.py (Python 3.11)
        │  - Commits rebuilt city JSONs
        │  - Pushes back to main branch
        ↓
  delhi.json, mumbai.json, bengaluru.json, hyderabad.json updated
        │
        │  Render (auto-deploy on push to main)
        ↓
  Live site updated
  Agents see latest prices, live panels, OOS status by ~9:15 AM IST
```

### Double Safety Mechanism

**Primary trigger:** Apps Script push to master.json → GitHub Action triggers on the `paths: ['assets/data/master.json']` condition.

**Fallback cron:** If Apps Script fails (Google infra issue, trigger missed, token expired), GitHub Actions has an independent daily cron at `3:30 UTC` (9:00 AM IST) that runs `build_cities.py` regardless. Even if master.json wasn't updated that day, the city JSONs are rebuilt with whatever is currently in master.json.

### Timeline

| Time | Event |
|------|-------|
| 9:00 AM IST | Apps Script trigger fires |
| ~9:02 AM IST | master.json pushed to GitHub |
| ~9:03 AM IST | GitHub Actions job starts |
| ~9:05 AM IST | City JSONs rebuilt, pushed to main |
| ~9:07 AM IST | Render deploys updated static site |
| ~9:10 AM IST | Agents see updated catalog |

### What Updates vs. What Doesn't

| Data | Updates Daily | Source |
|------|--------------|--------|
| Panel prices (per city) | ✅ Yes | Live_list Google Sheet |
| Panel live status (per city) | ✅ Yes | Live_list Google Sheet |
| Panel OOS status (per city) | ✅ Yes | OOS Google Sheet |
| Panel names, codes, images, dims | ❌ No | master.json (manual update) |
| Visual similarity scores | ❌ No | similarity_new.json (manual update) |

---

## 10. Repository Structure

```
/
├── index.html                  # City selector + PIN gate
├── quote.html                  # Quote builder (3 states: upload → review → results)
├── catalog.html                # Catalog browser (city tabs + filters)
├── render.yaml                 # Render static site config (publish dir: ".")
│
├── js/
│   ├── quote.js                # Core quote engine (OCR, parsing, PnC, pricing, render)
│   └── catalog.js              # Catalog renderer (city switching, filters, OOS badge)
│
├── css/
│   └── styles.css              # All styles — dark theme, component styles
│
├── assets/
│   ├── data/
│   │   ├── master.json         # 219 SKUs — base data, prices, live flags, OOS flags
│   │   ├── similarity_new.json # 196 panels with similarity matches (static)
│   │   ├── delhi.json          # Auto-built city catalog for Delhi
│   │   ├── mumbai.json         # Auto-built city catalog for Mumbai
│   │   ├── bengaluru.json      # Auto-built city catalog for Bengaluru
│   │   └── hyderabad.json      # Auto-built city catalog for Hyderabad
│   └── vendor/
│       ├── pdf.min.js          # pdf.js v3.11.174 — bundled, no CDN dependency
│       └── tesseract/
│           ├── tesseract.min.js     # Tesseract.js v5.1.1
│           └── tesseract-worker.js  # Worker script (pdf.js and Tesseract both need workers)
│
├── scripts/
│   └── build_cities.py         # Python script — builds city JSONs from master.json + similarity_new.json
│
└── .github/
    └── workflows/
        └── refresh-cities.yml  # GitHub Actions — triggers + build steps
```

### Gitignored Files (Never Commit, Never Push)

```
ship.sh          # Contains the Render deploy hook URL with a secret key — anyone with this URL
                 # can trigger a deploy of our site. Never commit.

test-quotes/     # Real customer quotation PDFs used for testing:
                 # Ruchika, Preeti, Shobhit — contain customer PII. Never publish.

tools/           # ML working scripts used during similarity computation (DINOv2, CLIP, etc.)
                 # Not needed for production.

pipeline/        # ML pipeline data — image embeddings, raw similarity matrices.
                 # Large files, not needed for production.
```

---

## 11. Data Files — Formats & Schemas

### `assets/data/master.json`

This is the **source of truth** for all panel data. Updated daily by Apps Script. Contains 219 SKUs.

```json
[
  {
    "code": "UC/I2/PPC/N0072",
    "name": "0072 WPC Ceramic Neutral",
    "material": "WPC",
    "dims": {
      "L_ft": 9.5,
      "W_in": 7.68,
      "T_mm": 7.5,
      "raw": "9.5 ft × 7.68 in × 7.5 mm"
    },
    "image": "https://urbancompany-images.s3.amazonaws.com/...",
    "price": {
      "delhi":     1450,
      "mumbai":    1650,
      "bangalore": 1600,
      "hyderabad": 1550
    },
    "live": {
      "delhi":     true,
      "mumbai":    true,
      "bangalore": true,
      "hyderabad": false
    },
    "oos": {
      "delhi":     false,
      "mumbai":    false,
      "bangalore": false,
      "hyderabad": false
    }
  }
]
```

**Important:** The Bengaluru city key in `master.json` is `"bangalore"` (no 'u'). This is a legacy naming inconsistency from when the data was first built. The output file is named `bengaluru.json`. `build_cities.py` handles the mapping explicitly.

### `assets/data/similarity_new.json`

Curated visual similarity data. Static file — does not change daily. Contains 196 panels.

```json
{
  "panels": [
    {
      "sku": "UC/D1/PPG/W0414",
      "name": "0952/0414 PVC Grooved Wood",
      "img": "https://...",
      "mat": "PVC",
      "mould": "Grooved",
      "finish": "Wood",
      "type": "Wall Panel",
      "matches": [
        { "sku": "UC/I2/PPD/W7073", "score": 77 },
        { "sku": "UC/D1/PPP/W0414", "score": 75 },
        { "sku": "UC/I2/PPC/W0609", "score": 71 }
      ],
      "alts": ["UC/D1/PPG/W0952"]
    }
  ]
}
```

`matches` is the primary field used by `build_cities.py`. Each entry has:
- `sku` — the alternative panel's SKU code
- `score` — similarity percentage (0–100)

Only matches where the alternative is also live in the same city and not OOS are included in the output city JSON.

### `assets/data/delhi.json` (and other city JSONs)

Auto-generated by `build_cities.py`. One file per city. Contains only panels that are live in that city, with city-specific prices and pre-filtered alternatives.

```json
{
  "panels": [
    {
      "name": "0072 WPC Ceramic Neutral",
      "code": "UC/I2/PPC/N0072",
      "material": "WPC",
      "dims": { "L_ft": 9.5, "W_in": 7.68, "T_mm": 7.5, "raw": "9.5 ft × 7.68 in × 7.5 mm" },
      "psf": 238,
      "perPanel": 1450,
      "image": "https://...",
      "search": "uc/i2/ppc/n0072 n0072 0072 wpc ceramic neutral wpc",
      "unique": false,
      "cheaperCount": 2,
      "oos": false,
      "alternatives": [
        {
          "name": "0609 WPC Ceramic Cool",
          "code": "UC/I2/PPC/W0609",
          "material": "WPC",
          "dims": { "L_ft": 9.5, "W_in": 7.68, "T_mm": 7.5, "raw": "9.5 ft × 7.68 in × 7.5 mm" },
          "psf": 199,
          "perPanel": 1210,
          "image": "https://...",
          "similarity": 81,
          "isCheaper": true,
          "diff": "▼ ₹240 cheaper",
          "scoreClass": "mid"
        }
      ]
    }
  ]
}
```

The `search` field is a pre-built lowercase string used for fast client-side search in the catalog (`data-search` attribute on each panel row).

`scoreClass` is either `"hi"` (≥85%) or `"mid"` (70–84%), used to color the similarity badge.

---

## 12. Apps Script (Google Sheet)

### Location
Google Sheet → Extensions → Apps Script

### What It Does (daily at 9 AM IST)

1. **Reads `Live_list` sheet**
   - Header: row 2 (not row 1 — row 1 is a display header)
   - Data: row 3 onwards
   - Columns expected: SKU Code, Delhi price, Mumbai price, Bengaluru price, Hyderabad price, Delhi live, Mumbai live, Bengaluru live, Hyderabad live
   - Builds a `liveMap`: `{ sku → { delhi, mumbai, bangalore, hyderabad } }` with prices and live booleans

2. **Reads `OOS` sheet**
   - Header: row 1
   - Data: row 2 onwards
   - Column A = Delhi OOS SKUs, B = Mumbai OOS SKUs, C = Bengaluru (stored as `bangalore`), D = Hyderabad
   - Builds an `oosSet`: `{ delhi: Set{...}, mumbai: Set{...}, bangalore: Set{...}, hyderabad: Set{...} }`

3. **Fetches `master.json` from GitHub**
   - Uses GitHub Contents API: `GET /repos/{owner}/{repo}/contents/assets/data/master.json`
   - Authenticates with `GITHUB_TOKEN` from Script Properties
   - Decodes base64 content, parses JSON

4. **Updates `live` and `oos` fields** on every panel in master.json

5. **Pushes back to GitHub**
   - `PUT /repos/{owner}/{repo}/contents/assets/data/master.json`
   - Must include the current file SHA (from the GET response) to avoid conflicts
   - This push triggers GitHub Actions

### One-Time Setup

```
1. Open the Google Sheet
2. Extensions → Apps Script
3. Left panel → Project Settings → Script Properties
4. Add property: GITHUB_TOKEN = <your GitHub Personal Access Token>
   (Token needs: repo → contents: write permission)
5. Run setupDailyTrigger() once from the Apps Script editor
   (Creates a time-based trigger for 9 AM every day)
```

### When to Run Manually

If prices change mid-day or a panel goes OOS urgently:
- Open Apps Script editor
- Click Run → `syncToGitHub`
- Wait ~30 seconds
- Check GitHub Actions tab — city JSONs will rebuild within 2–3 minutes
- Check Render dashboard — site will redeploy within 2–3 minutes after that

---

## 13. GitHub Actions Workflow

File: [`.github/workflows/refresh-cities.yml`](.github/workflows/refresh-cities.yml)

### Triggers

```yaml
on:
  push:
    paths: ['assets/data/master.json']   # Apps Script pushes this daily
  workflow_dispatch:                      # Manual run from GitHub Actions tab
  schedule:
    - cron: '30 3 * * *'                 # 9:00 AM IST fallback (UTC+5:30 → 3:30 UTC)
```

### Steps

1. `actions/checkout@v4` — checkout with `secrets.GITHUB_TOKEN` so it can push back
2. `actions/setup-python@v5` — Python 3.11
3. `python3 scripts/build_cities.py` — rebuilds all 4 city JSONs
4. Commit only if files changed (`git diff --cached --quiet` check prevents empty commits)
5. `git push` — this push triggers Render auto-deploy

### Permissions

```yaml
permissions:
  contents: write    # Needed to push rebuilt city JSONs back to the repo
```

### Running Manually

GitHub repo → Actions tab → "Rebuild City Catalogs" → Run workflow → Run workflow

Useful if you:
- Updated master.json directly (not via Apps Script)
- Changed `build_cities.py` logic
- Changed `similarity_new.json`

---

## 14. Quote Builder Logic — Step by Step

File: [`js/quote.js`](js/quote.js)

### State Machine

The quote builder has 3 states, each a separate `<section>`:

| State | ID | Visible when |
|-------|-----|-------------|
| Upload / dropzone | `#dropState` | Initial load, or after clicking "← Back" from review |
| Review | `#buildState` | After PDF is processed |
| Results | `#resultState` | After clicking "Generate Quotes →" |

### Step 1 — PDF Rendering (pdf.js)

```
User selects PDF file
→ FileReader reads it as ArrayBuffer
→ pdfjsLib.getDocument(buffer)
→ For each page: page.render({ canvasContext, viewport })
→ Canvas displayed in #pdfPages for visual reference
→ Canvas also passed to OCR
```

pdf.js is loaded from `assets/vendor/pdf.min.js`. The worker is set to the same path to keep everything offline.

### Step 2 — OCR (Tesseract.js)

```
Canvas image → Tesseract.recognize(canvas, 'eng')
→ raw text string per page
→ All pages concatenated into one text blob
```

OCR runs on the rendered canvas, not the raw PDF — this is the only way that works with Identity-H CID fonts.

### Step 3 — Parse

The raw OCR text is parsed with regex patterns to extract:

**Quote header:**
- Customer name (line near the top before "Interior Solutions")
- Subtotal (line containing "Sub total")
- Taxes & fees (line containing "Taxes")
- Grand total (line containing "Total amount")
- Discount line (line containing "Discount" and a %)

**Line items (panels):**
- Lines matching pattern: `{name} x{qty}` where qty is a number
- Duplicate lines across pages are deduplicated (UC PDFs sometimes repeat page headers)
- Lines that are sub-items (glue, clips, copper wire, trims, shelves, light kits) are identified and kept as accessories (not swapped)

### Step 4 — ₹ Reconciliation

OCR sometimes outputs `₹1,450` as `71,450` or `11,450` (misreading ₹ as 7 or 1). We detect and correct this:

```
Check: S0 + T0 − D0 ≈ G0
If not, try removing leading digit from each number and re-check
Once identity holds, those are the correct values
```

### Step 5 — Panel Matching

For each parsed line item name, we look up a match in the loaded city catalog:

1. **Exact code match** — if the name string contains a code like `UC/I2/PPC/N0072`
2. **Exact name match** — normalized (lowercase, strip punctuation)
3. **Fuzzy word overlap** — tokenize both strings, count overlapping words. If overlap ≥ 45% of the query words, it's a match. Takes the highest-scoring match.

Panels with no match are treated as **accessories** (fixed cost, not swappable). Panels with a match are **replaceable panels**.

### Step 6 — Review Screen

Agent sees:
- Left: the PDF pages rendered by pdf.js
- Right: extracted totals (editable), panel table (each row: qty, matched panel, ₹/panel, cheaper alt count)
- Accessory residual: `subtotal − Σ(panel cost)` — this is the fixed cost portion (accessories). Shown as a sanity check.
- Autocomplete search to add panels manually

### Step 7 — PnC Generation

```javascript
function recurse(idx, current) {
  if (idx === panels.length) { results.push(current); return; }
  var panel = panels[idx];
  // include original (no swap for this panel)
  recurse(idx+1, [...current, {panel, swap: null}]);
  // try each cheaper swap
  for (var swap of panel.cheaperSwaps) {
    recurse(idx+1, [...current, {panel, swap}]);
    if (results.length >= MAX_QUOTES) return;
  }
}
```

After generation:
- Filter: `savedVsOrig > 0`
- Dedup by swap key
- Sort by `savedVsOrig` descending
- Cap at 100

### Step 8 — Render Results

Each quote card shows:
- Which panels were swapped (thumbnail + name + similarity %)
- New total (large, prominent)
- ₹ saved vs original (green badge)
- Discount applied
- "View full quote" → modal with complete line breakdown

If no quotes passed the filter, `#noQuotes` is shown with an accurate message explaining why.

---

## 15. Catalog Logic

File: [`js/catalog.js`](js/catalog.js)

### City Switching

City tabs fire `setCity(city)` which:
1. Fetches `assets/data/{city}.json`
2. Renders all panels with `renderPanel()`
3. Updates the URL to `?city={city}` (no page reload)
4. Applies current filter state

On load, city is read from `?city=` query param (defaults to `delhi`).

### Filter Logic

Two filters: search text + "Cheaper panels only" checkbox.

A panel row is hidden if:
- Search text doesn't match `row.dataset.search` (the pre-built search string)
- "Cheaper only" is checked AND `row.dataset-cheaper` (cheaperCount) is 0

When "Cheaper only" is checked and a panel row IS shown, individual alternative cards within that row are also filtered — cards without `.is-cheaper` class are hidden. This ensures expensive alternatives don't appear in the rail even for panels that have at least one cheaper option.

### Rendering

Each panel is a `<section class="row">` containing:
- `.selcard` — the main panel (with OOS badge if `p.oos`)
- `.railwrap > .rail` — scrollable horizontal row of `.card` alternatives
- OR `.nomatch` if `p.alternatives.length === 0`

Alternatives with `isCheaper: true` get the `.is-cheaper` class on their `.card` element.

---

## 16. PIN Gate

File: [`index.html`](index.html)

On load, `#appWrap` (the city selector) is hidden and `#gateWrap` (the PIN screen) is visible. Four digit input boxes (each takes 1 digit, auto-advances to next box) combine to form the PIN.

On correct PIN (`1402`):
- `#gateWrap` fades out
- `#appWrap` fades in
- `sessionStorage.setItem('unlocked', '1')` is set

On subsequent page loads within the same browser session, if `sessionStorage.unlocked === '1'`, the gate is skipped automatically. Opening a new browser window/tab requires entering the PIN again.

**Note:** This is a lightweight deterrent, not real security. The site content is publicly accessible if someone knows the URL. It's meant to prevent casual stumbling-upon by the customer, not to protect sensitive data.

---

## 17. Running Locally

```bash
# Navigate to the project directory
cd /Users/vaibhav/Desktop/IST

# Start a local HTTP server
python3 -m http.server 8000

# Open in browser
open http://localhost:8000
# PIN: 1402
```

You need a local HTTP server (not `file://`) because:
- pdf.js uses a Web Worker (`importScripts`) which requires HTTP
- Tesseract.js uses a Web Worker too
- Fetching JSON data files uses `fetch()` which is blocked on `file://`

To rebuild city JSONs after any data changes:
```bash
python3 scripts/build_cities.py
```

Expected output:
```
delhi      : 87 panels |  312 alt-links | 127 cheaper alts | → assets/data/delhi.json
mumbai     : 74 panels |  266 alt-links | 102 cheaper alts | → assets/data/mumbai.json
bengaluru  : 71 panels |  249 alt-links |  97 cheaper alts | → assets/data/bengaluru.json
hyderabad  : 63 panels |  218 alt-links |  85 cheaper alts | → assets/data/hyderabad.json
```

---

## 18. Deploying to Render

Render is configured to auto-deploy from the `main` branch of the GitHub repo. There is nothing to configure per deployment.

**Normal deploy flow:**
```
git add <files>
git commit -m "your message"
git push origin main
```
→ Render detects the push → deploys within 1–2 minutes.

**Immediate redeploy without a code change** (e.g., to pick up fresh city JSONs):
```bash
./ship.sh
```
(This script is gitignored — it contains the Render deploy hook URL.)

**Render settings:**
- Type: Static Site
- Build command: *(empty)*
- Publish directory: `.`
- Auto-deploy: On (from `main` branch)

---

## 19. How to Update the Catalog Data

### Add a new panel to the catalog

1. Add the panel's data to `master.json` with all required fields (`code`, `name`, `material`, `dims`, `image`, `price`, `live`, `oos`)
2. Add similarity matches to `similarity_new.json` under `panels` (run the ML pipeline to get scores, or manually judge and add)
3. Run `python3 scripts/build_cities.py` locally
4. Push → GitHub Actions will rebuild city JSONs automatically

### Update panel prices

Prices update automatically daily via Apps Script from the Google Sheet. To update manually:
- Edit the price in the Google Sheet (`Live_list` tab)
- Run `syncToGitHub()` from Apps Script editor
- Or wait for the next 9 AM sync

### Mark a panel as OOS

- Add the SKU code to the `OOS` tab in the Google Sheet under the correct city column
- Run `syncToGitHub()` from Apps Script (or wait for 9 AM)
- To un-OOS: remove the SKU from the OOS tab

### Mark a panel as live/not live for a city

- Update the live flag in the `Live_list` Google Sheet
- Run `syncToGitHub()` (or wait for 9 AM)

### Update similarity scores

`similarity_new.json` is a static file — changes require a manual edit and commit:
1. Edit `assets/data/similarity_new.json`
2. Run `python3 scripts/build_cities.py` locally to verify
3. Commit and push

---

## 20. Troubleshooting

### OCR reads wrong totals

The ₹ sign is commonly misread as a digit. The reconciliation logic (`S+T−D=G` identity check) usually catches and corrects this automatically. If it still fails, use the review screen to manually correct the extracted subtotal/taxes/total before generating quotes.

### "No cheaper quotes" message but there should be

Could be one of three issues:
1. **OOS:** The cheaper alternatives are OOS today → they'll appear again once removed from OOS sheet
2. **Area recompute:** The alternative panel requires more qty due to size difference, making it net-more-expensive. This is correct behavior.
3. **Discount slab crossing:** The alternative drops the subtotal below a slab threshold, increasing the discount loss by more than the panel saving. Also correct behavior.

### City JSONs not updating after Google Sheet change

Check in order:
1. Google Sheet → Apps Script → Executions — did `syncToGitHub` run successfully?
2. GitHub → commits — was `master.json` updated?
3. GitHub → Actions — did the workflow trigger and complete?
4. Render → Deploys — did Render pick up the push?

If Apps Script ran but GitHub API returned an error, the most common cause is a stale SHA (someone else pushed master.json since Apps Script fetched it). Re-run `syncToGitHub()` manually.

### GitHub Actions fails with push conflict

This happens when GitHub Actions is also running while we push locally. Solution:
```bash
git fetch origin
git rebase origin/main
# If city JSONs conflict:
git checkout --theirs assets/data/delhi.json assets/data/mumbai.json assets/data/bengaluru.json assets/data/hyderabad.json
python3 scripts/build_cities.py
git add assets/data/*.json
git rebase --continue
git push origin main
```

### Render not deploying

1. Check Render dashboard → Events — is there a deploy queued or failing?
2. Run `./ship.sh` to force-trigger a deploy hook
3. If that fails, go to Render → Manual Deploy → Deploy latest commit

---

## 21. Security & Secrets

### What is Secret and Where It Lives

| Secret | Where | Notes |
|--------|-------|-------|
| Render deploy hook URL | `ship.sh` (gitignored) | Contains a secret key — treat like a password |
| GitHub PAT (Personal Access Token) | Apps Script Script Properties as `GITHUB_TOKEN` | Needed for Apps Script to push master.json to GitHub |
| Service account JSON key | GCP (should be rotated) | `cheaper-quote-sync@istallcity.iam.gserviceaccount.com` |

### What is NOT Secret

| Item | Why it's fine |
|------|---------------|
| PIN (1402) | Lightweight access control, not protecting sensitive data |
| Panel prices | Internal reference data, no competitive risk |
| GitHub Actions `GITHUB_TOKEN` | This is GitHub's built-in token, auto-provided to Actions, not our PAT |

### Customer Data Handling

- Customer PDFs are **never uploaded anywhere** — OCR runs entirely in the browser
- No network requests are made during quote generation
- Test quote PDFs (`test-quotes/`) are gitignored and must never be committed
- The only outbound network call the site makes is to load `assets/data/*.json` from Render's CDN (our own files)

### What to Do If a Secret is Compromised

**Render deploy hook leaked:**
1. Render dashboard → Settings → Build & Deploy → Deploy Hook → Regenerate
2. Update `ship.sh` with the new URL

**GitHub PAT leaked:**
1. GitHub → Settings → Developer settings → Personal access tokens → Revoke the token
2. Generate a new token with only `contents:write` on the IST repo
3. Update in Apps Script: Script Properties → `GITHUB_TOKEN`

**Service account key compromised:**
1. GCP Console → IAM → Service Accounts → `cheaper-quote-sync@istallcity.iam.gserviceaccount.com` → Keys → Delete compromised key → Add new key
2. Update wherever the key is used
