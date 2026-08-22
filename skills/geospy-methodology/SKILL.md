---
name: geospy-methodology
description: Advanced prompt engineering and methodology
---

# GeoSpy Prompt Methodology
## Chain-of-Clue Reasoning for Autonomous Geolocation

---

### Core Principle
Treat every image as a crime scene of geography.
Do not guess coordinates. Build a probability lattice from 9 independent signal classes, then falsify candidates until one survives.

---

## 1. Signal Taxonomy (The 10 Signals)

| # | Signal Class | What to Extract | Confidence Weight |
|---|---|---|---|
| 1 | Forensics / EXIF | GPS, camera model, timestamps, software artifacts | 0.15 |
| 2 | Chronolocation | Shadow vectors, sun azimuth/elevation, season bounds | 0.10 |
| 3 | Infrastructure | Utility poles, road signage, mailbox styles, license plates, power grids | 0.12 |
| 4 | Ecology | Canopy species, leaf phenology, soil color, Köppen climate match | 0.08 |
| 5 | Text & Symbols | OCR: street signs, business names, language script, postal formats | 0.15 |
| 6 | Architecture | Building era, facade material, roof type, window density, density patterns | 0.13 |
| 7 | Terrain & Satellite | Horizon angle, elevation, cross-view aerial match, parcel geometry | 0.10 |
| 8 | Camera Geometry | FOV estimate, camera height, horizon line ratio, lens distortion | 0.05 |
| 9 | Vector Similarity | DINOv2 / SigLIP embeddings, ANN retrieval, rerank score | 0.07 |
| 10 | Proximity Constraints | Walk-time to nearest park, 8-10 min filter, transit access | 0.05 |

---

## 2. The GeoSpy Prompt Chain

### Phase 1 — Visual Ingestion
```
Analyze this image across all 10 signal classes.
Return a structured JSON with:
{
  "dominant_colors": [],
  "material_hues": {},
  "building_type": "",
  "floors_estimate": 0,
  "roof_type": "",
  "window_density": 0.0,
  "road_type": "",
  "has_sidewalk": true/false,
  "vegetation_density": 0.0,
  "tree_types": [],
  "shadow_direction_deg": 0.0,
  "shadow_length_ratio": 0.0,
  "estimated_time_of_day": "",
  "architectural_style": "",
  "era_estimate": "",
  "region_indicators": [],
  "detected_text": [],
  "license_plates": [],
  "sign_types": [],
  "sky_percentage": 0.0,
  "weather_condition": "",
  "perspective_lines": 0
}
If a value is unknown, return null — do not hallucinate.
```

### Phase 2 — Region Hypothesis
```
Given these region indicators:
{region_indicators}

And architecture style:
{architectural_style}

And era estimate:
{era_estimate}

List the top 7 candidate cities/regions globally, with confidence scores.
For each candidate, justify with at least one signal match.
```

### Phase 3 — Candidate Coordinate Generation
```
For each region, generate a search radius of 3-8 km.
Within that radius, return all plausible coordinates where:
  - Building density x footprint matches the image
  - Within 800 m of a park (if nearPark constraint is active)
  - Matches architectural typology database

Return an array of {lat, lng, confidence, match_type, distance_km}.
Max 20 candidates.
```

### Phase 4 — Cross-View Verification
```
For each candidate coordinate:
  1. Fetch satellite tile at zoom 18.
  2. Compute footprint-to-building ratio.
  3. Compare edge density and color histogram to ground image.
  4. If diverge > 0.35, drop candidate.

Return verification_results with:
{
  "lat": 43.65,
  "lng": -79.38,
  "verified": true/false,
  "satellite_match_confidence": 0.0-1.0,
  "street_view_available": true/false
}
```

### Phase 5 — Park Proximity Filter
```
If nearPark == true:
  For each remaining candidate:
    - Find parks within walk_minutes * 100 m radius
    - Calculate actual walking distance via Directions API
    - Confirm 8 <= walk_minutes <= 10
    - If no park within 10 min, drop candidate

Return final candidates sorted by composite score.
```

### Phase 6 — Synthesis Report
```
Synthesize final report:
{
  "best_estimate": {lat, lng, confidence},
  "composite_confidence": 0.0-1.0,
  "confidence_factors": {
    "architecture": 0.x,
    "region": 0.x,
    "satellite": 0.x,
    "proximity": 0.x
  },
  "eliminated_candidates": [
    {"lat": x, "lng": y, "reason": "walk time to nearest park = 14 min"}
  ],
  "next_actions": [
    "Open Google Maps at {lat},{lng}",
    "Check Street View for fire escape and brick color"
  ]
}
```

---

## 3. Prompt Injection Guardrails

**DO NOT:**
- Hallucinate coordinates that do not pass Phase 4 verification
- Return a single candidate without showing eliminated alternatives
- Use random jitter (np.random.uniform) as a substitute for satellite matching
- Mix units (meters vs km, minutes vs seconds)
- Skip OCR if text is clearly visible (license plates, street signs, business names)

**DO:**
- Always run the full pipeline even if early signals strongly suggest one region
- Cache every Google Maps API response to ./cache/ with MD5 filename
- Log every elimination reason for audit trail
- Prefer API evidence over heuristic region priors
