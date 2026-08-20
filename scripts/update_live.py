#!/usr/bin/env python3
"""
Fetch latest Live_list from published Google Sheet CSV and update assets/data/master.json.

Setup (one-time):
  1. Open your Google Sheet
  2. File → Share → Publish to web
  3. Choose sheet: "Live_list" → Format: CSV → Publish
  4. Copy the URL
  5. Add as GitHub Secret named SHEET_LIVE_CSV_URL

Run locally:
  SHEET_LIVE_CSV_URL="https://docs.google.com/spreadsheets/d/..." python3 scripts/update_live.py

Run in CI: env var is injected automatically by the workflow.
"""

import csv, json, os, sys, urllib.request

ROOT        = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER_PATH = os.path.join(ROOT, "assets", "data", "master.json")

URL = os.environ.get("SHEET_LIVE_CSV_URL", "")
if not URL:
    print("ERROR: SHEET_LIVE_CSV_URL env var not set.", file=sys.stderr)
    sys.exit(1)

print(f"Fetching live list from sheet…")
with urllib.request.urlopen(URL, timeout=30) as r:
    text = r.read().decode("utf-8")

reader  = csv.DictReader(text.splitlines())
headers = reader.fieldnames or []
print(f"CSV columns: {headers}")

# Normalise column names (strip whitespace, case-insensitive lookup)
def col(row, *candidates):
    for c in candidates:
        for k in row:
            if k.strip().lower() == c.lower():
                return str(row[k]).strip()
    return ""

def is_live(val):
    return val.strip() in ("1", "1.0", "TRUE", "true", "True", "Yes", "yes")

# Build {code: {delhi, mumbai, bangalore, hyderabad}} from CSV
live_map = {}
for row in reader:
    code = col(row, "SKU Code", "SKU_CODE", "sku code")
    assortment = col(row, "Assortment type", "Assortment_type", "assortment type")
    if not code or assortment.lower() != "panel":
        continue
    live_map[code] = {
        "delhi":     is_live(col(row, "Delhi", "delhi")),
        "mumbai":    is_live(col(row, "Mumbai", "mumbai")),
        "bangalore": is_live(col(row, "Bangalore", "bangalore", "Bengaluru", "bengaluru")),
        "hyderabad": is_live(col(row, "Hyderabad", "hyderabad")),
    }

print(f"Parsed {len(live_map)} panel rows from CSV")

with open(MASTER_PATH) as f:
    master = json.load(f)

updated = 0
for m in master:
    code = m["code"]
    if code in live_map:
        m["live"] = live_map[code]
        updated += 1

with open(MASTER_PATH, "w") as f:
    json.dump(master, f, indent=1, ensure_ascii=False)

print(f"Updated {updated}/{len(master)} entries in master.json")
