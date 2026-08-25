#!/usr/bin/env python3
"""
Build per-city panel catalog JSONs from master.json + similarity_new.json.

similarity_new.json is extracted from the curated similarity_review HTML
(196 SKUs, each with matches:[{sku, score}] resolved to full SKU codes).

Output: assets/data/{delhi,mumbai,bengaluru,hyderabad}.json
Format is compatible with the existing panels.json used by the quote builder.

Run: python3 scripts/build_cities.py
"""

import json, math, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER_PATH = os.path.join(ROOT, "assets", "data", "master.json")
SIM_PATH    = os.path.join(ROOT, "assets", "data", "similarity_new.json")
OUT_DIR     = os.path.join(ROOT, "assets", "data")

CITIES = {
    "delhi":     "delhi",
    "mumbai":    "mumbai",
    "bengaluru": "bangalore",   # master.json key is "bangalore"
    "hyderabad": "hyderabad",
}

def area(dims):
    L = dims.get("L_ft", 0)
    W = dims.get("W_in", 0)
    return L * (W / 12.0) if L and W else 0

def build_search(code, name, material):
    short = code.split("/")[-1] if "/" in code else code
    parts = [code.lower(), short.lower(), name.lower(), material.lower()]
    return " ".join(dict.fromkeys(p for p in parts if p))

def score_class(pct):
    return "hi" if pct >= 85 else "mid"

def diff_text(panel_price, alt_price):
    d = alt_price - panel_price
    if d < 0:
        return f"▼ ₹{abs(d):,} cheaper"
    elif d > 0:
        return f"▲ ₹{d:,} premium"
    return "= same price"

def build_city(city_key, master_key, master, sim_by_code):
    live_panels = {m["code"]: m for m in master if m["live"].get(master_key)}

    panels = []
    for code, m in live_panels.items():
        price = m["price"].get(master_key, 0)
        a = area(m.get("dims", {}))
        psf = round(price / a) if a > 0 else 0

        sim_entry = sim_by_code.get(code, {})
        # matches: [{sku, score}] — curated from similarity_review HTML
        raw_matches = sim_entry.get("matches", [])

        alts = []
        seen = set()
        for match in raw_matches:
            ac    = match["sku"]
            score = match["score"]
            if ac == code or ac in seen:
                continue
            seen.add(ac)
            am = live_panels.get(ac)   # only include if also live in this city
            if not am:
                continue
            if am.get("oos", {}).get(master_key, False):
                continue              # skip OOS panels as alternatives
            alt_price = am["price"].get(master_key, 0)
            if not alt_price:
                continue
            alt_a   = area(am.get("dims", {}))
            alt_psf = round(alt_price / alt_a) if alt_a > 0 else 0
            alts.append({
                "name":       am["name"],
                "code":       am["code"],
                "material":   am.get("material", ""),
                "dims":       am.get("dims", {}),
                "psf":        alt_psf,
                "perPanel":   alt_price,
                "image":      am.get("image", ""),
                "similarity": score,
                "isCheaper":  alt_price < price,
                "diff":       diff_text(price, alt_price),
                "scoreClass": score_class(score),
            })

        cheaper_count = sum(1 for a in alts if a["isCheaper"])

        panels.append({
            "name":         m["name"],
            "code":         m["code"],
            "material":     m.get("material", ""),
            "dims":         m.get("dims", {}),
            "psf":          psf,
            "perPanel":     price,
            "image":        m.get("image", ""),
            "search":       build_search(code, m["name"], m.get("material", "")),
            "unique":       len(alts) == 0,
            "cheaperCount": cheaper_count,
            "alternatives": alts,
        })

    panels.sort(key=lambda p: p["name"])
    return {"panels": panels}

def main():
    with open(MASTER_PATH) as f:
        master = json.load(f)
    with open(SIM_PATH) as f:
        sim = json.load(f)

    # similarity_new.json has {panels: [{sku, matches, alts, ...}]}
    # Build lookup: sku → {matches, alts}
    sim_by_code = {p["sku"]: p for p in sim.get("panels", [])}

    for city_key, master_key in CITIES.items():
        data = build_city(city_key, master_key, master, sim_by_code)
        out  = os.path.join(OUT_DIR, f"{city_key}.json")
        with open(out, "w") as f:
            json.dump(data, f, indent=1, ensure_ascii=False)

        n_panels  = len(data["panels"])
        n_alts    = sum(len(p["alternatives"]) for p in data["panels"])
        n_cheaper = sum(p["cheaperCount"] for p in data["panels"])
        print(f"{city_key:12s}: {n_panels:3d} panels | {n_alts:4d} alt-links | {n_cheaper:3d} cheaper alts | → {out}")

if __name__ == "__main__":
    main()
