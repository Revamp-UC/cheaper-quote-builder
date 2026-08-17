# Make Alternative Cheaper Quote

Internal tool for UrbanCompany. Upload a customer wall-panel quotation PDF — it
reads the panels, quantities and totals automatically (free in-browser OCR),
finds visually-similar **cheaper** panels from the catalog, and generates every
alternative quote (PnC) with taxes & discount recomputed.

- **`index.html`** — the Quote Builder tool (site root)
- **`catalog.html`** — the 116-panel visual similarity catalog
- **`css/`, `js/`, `assets/`** — styles, logic, images + vendored libraries

Everything runs **client-side**: no backend, no API keys, no external calls.
PDF rendering (pdf.js) and OCR (Tesseract.js) are vendored under
`assets/vendor/`, so the site works fully offline once loaded.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy on Render

1. Push this repo to GitHub (see below).
2. In Render: **New → Static Site → connect this repo**.
3. Settings (Render auto-detects `render.yaml`):
   - **Build command:** _(leave empty)_
   - **Publish directory:** `.`
4. Create — you get a public `https://<name>.onrender.com` URL to share.

## Push to GitHub

```bash
git init
git add .
git commit -m "Cheaper Quote Builder"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

> Note: `test-quotes/` (real customer PDFs) and `tools/` (dev scripts) are
> git-ignored and will **not** be published.
