# THE JUDGE — CORE PROTOCOL & TECHNICAL SPECIFICATION MANIFESTO

**The Definitive Elite-Tier Pre-Submission Diagnostic Protocol & Comprehensive Global Business Plan**

*Last amended: September 29, 2026. Sections marked **(amended Sept 2026)** were updated from real-device development and testing. See Section 10 for the full amendment log.*

---

## 1. EXECUTIVE PRODUCT POSITIONING, VISION, & MARKET DISRUPTION

### The Core Mission

To democratize high-grade trading card valuation by delivering an absolute, automated, unbiased, and instantaneous diagnostic grading expert into the hands of every collector globally.

### The Market Void

Traditional physical grading laboratories (such as PSA, BGS, SGC, and CGC) operate on slow turnaround times, aggressive and volatile submission pricing tiers ($15 to $100+ per card), and heavily criticized human subjectivity. Existing mobile alternatives (e.g., Ludex, CollX) function primarily as simple inventory checklist scanners or rely entirely on rigid, cost-prohibitive, flat-image third-party APIs (such as Ximilar). These legacy solutions suffer from high per-image overhead and lack the granular micro-defect analysis required to evaluate high-value assets.

### Our Disruptive Solution

"The Judge" is engineered to be the definitive global software benchmark for trading card verification, structural diagnostics, and raw market valuation. Rather than seeking to immediately replace the physical encapsulation and serialization mechanisms of legacy grading laboratories, "The Judge" operates as an indispensable, high-utility pre-submission diagnostic ecosystem. It serves two distinct market pillars:

- **The Risk-Mitigation Engine:** Providing elite investors and everyday collectors with mathematical forecasting of legacy lab outcomes before capital is deployed on physical submission and shipping fees.
- **The Raw Market Trade Standard:** Acting as a trusted, objective, raw-case pricing protocol for brick-and-mortar hobby shops, regional trading conventions, and peer-to-peer raw inventory transactions.

"The Judge" delivers objectivity, instant multi-dimensional reports, and reproducibility. If the card's physical condition has not altered, the system should output the same grade across repeated scans.

**Reproducibility standard (amended Sept 2026):** Reproducibility is measured, not assumed. Every engine release must meet published repeatability targets on the fixed test deck (Section 9). For example, centering on a stationary card must stay within a 3-point ratio spread across repeated scans. Current hi-res result: 0.7 points left/right and 0.4 points top/bottom, on 12 real scans.

```
                  [ USER DEVICE / NATIVE CAPTURE CLIENT ]
                                         │
      (Exposure-Locked Full-Resolution Stills + Guided Tilt "Condition Sweep")
                                         │
                                         ▼
       [ ON-DEVICE CAPTURE CONTROL — card corner detection & crop only ]
             (Controls computational photography at the source)
                                         │
                                         ▼
                     [ PROP_CORE COMPUTER VISION SYSTEM PIPELINE ]
                      (Server-side; perspective-corrected, in mm)
      ┌──────────────────────┬──────────────────────┬──────────────────────┐
      │                      │                      │                      │
      ▼                      ▼                      ▼                      ▼
 [CENTERING METROLOGY]   [EDGE SCANNER]      [CORNER PROFILER]     [SURFACE INSPECTOR]
 (Sub-Pixel Boundary)   (Contrast/Chipping)   (Sports vs. TCG)     (Specular Glare Stream)
      │                      │                      │                      │
      └──────────────────────┴───────────┬──────────┴──────────────────────┘
                                         │
                                         ▼
                         [ ISOLATED PROPRIETARY SCORING MODULE ]
                         (Dynamic Sub-Grade Weighting Formula)
                                         │
                                         ▼
                        [ THE DUAL-SCALE GRADED RESPONSE ]
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
     [PREDICTIVE LEGACY SIMULATION]               ["THE JUDGE" TRUE GRADE SCALE]
     (PSA / BGS / SGC Tolerances)                 (100-Point Absolute Precision)
                                         │
                                         ▼
                        [ CONTINUOUS ML FLYWHEEL REGISTER ]
    (Versioned engine · archived originals · PSA ground truth · user overrides)
```

---

## 2. THE LIVING CONTINUUM & ETHOS OF INFINITE SELF-IMPROVEMENT

"The Judge" is fundamentally not a static software product, a basic scanning wrapper, or a simplified tool built for casual convenience at the expense of accuracy. It is designed as a living, continuous continuum of updating knowledge and autonomous machine learning.

### The Living Adaptability Clause

The software architecture incorporates a continuous learning loop. Every digital ingestion, granular scan, and verified physical outcome creates data arrays that securely feed back into our custom training repository. As users submit image data and correct grading deviations, the aggregated data creates a proprietary machine-learning flywheel, continuously increasing the platform's accuracy and enterprise asset value over time.

### How the Living Continuum Is Implemented (amended Sept 2026)

- **Engine versioning:** Every grade is stamped with the grading-engine version that produced it.
- **Archived originals:** Original captures and their metadata are retained, so any new engine can be back-tested against the full archive before release. Old scans can be re-graded when the engine improves, so users' vaults get better over time.
- **Back-testing release gate:** No engine change ships until it has been re-run against archived real scans and the fixed test deck, and shown to be equal or better. This was first proven in September 2026, when a new border finder was validated on 12 archived real scans (12/12 measured vs 8/12 for the prior engine) before release.
- **Device-adaptive evolution:** As phones gain better cameras and sensors, larger photo sizes and RAW are adopted only when the test deck shows they improve results (Section 6). Measurements stay in physical units, so a capture change does not change the grading rules.

### Uncompromised Market Dominance

This platform is engineered to outperform anything else on the global market. By moving entirely away from rigid flat-image processing, "The Judge" gives everyday collectors an institutional-grade advantage before buying raw inventory or risking capital on submission fees, while commanding authority among elite, seven-figure alternative-asset investors.

---

## 3. THE DUAL-SCALE GRADING MATRIX

To secure complete authority across all tiers of the trading card industry, from casual hobbyists to ultra-high-net-worth portfolio managers, the grading pipeline processes and renders two distinct diagnostic conclusions simultaneously:

### A. The Predictive Legacy Tier (Simulation Engine)

- **Objective:** Replicate the real-world grading tolerances, structural criteria, and historical leniencies of major grading bodies.
- **Logic Framework:** Programmed to accommodate known legacy grading variations. For example, PSA's published Gem Mint 10 front centering allowance is approximately 55/45 to 60/40, and BGS applies strict sub-grade calculations.
- **Current calibration (amended Sept 2026):** The centering sub-grade uses PSA's published front standard at the **strict end** of each range: worst-axis larger share ≤55 → 10, ≤60 → 9, ≤65 → 8, ≤70 → 7, ≤80 → 6, ≤85 → 5, ≤90 → 3, >90 → 1. This is a deliberately conservative starting point. It will be recalibrated toward PSA's actual behavior using ground-truth data from real submissions (Section 9).

### B. "The Judge" True Grade Scale (Uncompromising Precision)

- **Objective:** Eradicate human subjectivity, institutional bias, and environmental variance by deploying a rigorous, 100-point mathematical condition scale.
- **Logic Framework:** A true condition metric where perfection requires exact geometric symmetry and a zero-defect surface. This scale serves as the precise benchmark for pricing raw, unencapsulated cards in retail showcases, establishing a new standard for peer-to-peer commerce.
- **Scale reconciliation (open item, amended Sept 2026):** The current engine computes sub-grades on the familiar 0–10 legacy scale and also reports each as a 0–100 projection. The final definition of the 100-point True Grade (formula, weighting, and relationship to the 0–10 legacy tier) is still to be finalized.

---

## 4. ADVANCED PRODUCT & TECHNICAL ARCHITECTURE (MODULAR PROPRIETARY PIPELINE)

The application stack is built on a modular framework optimized for fast execution, horizontal microservice scaling, and complete freedom from dependency on third-party vision APIs.

### Module A: Capture Control & Image Integrity (amended Sept 2026)

*Formerly: "Image Pre-Processing (Anti-Distortion Engine)."*

Modern smartphone hardware injects aggressive computational photography (auto-exposure re-metering, HDR, artificial sharpness, edge smoothing, over-saturation, and "cartooning" textures) to make casual photos look appealing. These modifications degrade structural data.

- **Original assumption:** Post-hoc filters could restore an already-processed photo to its raw, authentic state.
- **Finding from testing:** This is not achievable for grading purposes. Once the phone has processed the image, the information is gone. In testing, auto-exposure exposed bright white-border cards down into the same brightness range as dark cards, making borders undetectable. It was confirmed as the same root cause as the "cartooning" effect.
- **The Living Rule (amended):** Control computational photography **at capture**, rather than trying to undo it afterward:
  - Lock exposure and white balance once per scanning session.
  - Capture full-resolution stills from the photo pipeline, not preview video frames.
  - Larger photo sizes and RAW/ProRAW are adopted only when the test deck shows they improve results. Until then, capture stays at 12 MP JPEG.
  - Detect the card's corners on-device and upload a full-detail, perspective-ready crop.
- Server-side, every card is perspective-corrected to a standard geometry and measured in **physical units (millimeters)**, using the standard card size of 63.5 × 88.9 mm, so results are independent of the phone that captured them.

### Module B: The Quad-Grading Core Pipeline (Structural & Forensic Matrices)

**Centering Metrology Engine**

- Measures exact horizontal-to-vertical border ratios. For bordered cards, it measures the printed border width on each side of the perspective-corrected card.
- For borderless / full-bleed cards, it compares the printed image position against a database of manufacturer set templates, which requires card identification first ("Track 2").
- Detects off-center printing down to a fraction of a millimeter (e.g., matching Beckett's strict 50/50 standard).
- **Status (amended Sept 2026):** Bordered-card centering is live and repeatable on real devices. It uses a robust edge-profile border finder with multi-line voting and outlier rejection, and it shows the collector an overlay of exactly where each border was measured. When borders cannot be measured reliably, it honestly reports "undetectable" rather than guessing. Next steps: higher-resolution sub-pixel measurement in millimeters and validation across the full test deck.

**Edge Scanner**

- Tracks contrast anomalies, structural disruptions, color/pigment saturation, and high-frequency light variations along all four card boundaries to detect silvering, edge chipping, paper layer whitening, factory cutting defects, or artificial re-coloring alterations.
- **Status (amended Sept 2026):** The first-generation detector confused a card's printed white border with edge whitening. It is disabled and reported as "not measured" until rebuilt and validated.

**Corner Profiler**

- Uses separate, modular computer vision models targeted by card class: sharp 90-degree corner tracking for standard sports cards, and multi-point radius curvature tracking for TCG cards (e.g., Pokémon, Magic: The Gathering).
- Detects microscopic rounding, soft stock impacts, or multi-layer paper pulp delamination (splitting).
- **Status (amended Sept 2026):** The first-generation detector scored bright white paper as corner wear. It is disabled and reported as "not measured" until rebuilt and validated on real worn cards.

**Surface Inspector (Condition Sweep)**

- Standard, flat, single-perspective captures cannot visualize micro-scratches, faint print lines, surface dimples, or indentation defects.
- **The Protocol:** The platform initiates a guided "Condition Sweep," prompting the user via an onscreen overlay to tilt the card or phone under direct lighting.
- **Current implementation (amended Sept 2026):** A multi-angle still sweep. After the level capture, the app guides the user through tilt positions (pitch and roll ±12°) and captures exposure-locked stills at each angle. Higher-quality stills were preferred over the originally planned 30fps video for the first version. Sweep data is currently collected as diagnostics only. It will be promoted into scoring once it is shown to separate real defects from glare artifacts.
- **The Algorithmic Logic:** The backend analyzes pixel-level contrast fluctuations (specular glare transitions) and shadow dips across angles. It isolates impressions (indentations and dimples) from surface scratches and transient dust particles.
- **Status:** The single-image surface detector read the border-to-art line as a crease. It is disabled and reported as "not measured" until rebuilt.

### Module C: Forensic Counterfeit & Alteration Detection

- **Micro-Metrology Dimension Verification:** Measures the card's exact physical width and height (in millimeters) to flag altered or trimmed cards before submission. Device-adaptive, millimeter-based capture (Module A) is the foundation for this.
- **Rosette Pattern Ink Matrix Analysis:** Runs a texture frequency filter to verify the print matrix's authenticity by tracking the distinct CMYK halftone "rosette" dot patterns found in authentic production runs, flagging pixelated commercial laser counterfeits. Requires the highest-resolution captures available.

### Module D: Isolated Proprietary Scoring Module

- **The Logic Framework:** Unlike third-party wrappers whose scoring metrics are hardcoded into an external engine, our platform uses a completely decoupled, isolated scoring formula. Sub-grade weights can be adjusted via configuration profiles (e.g., heavily weighting surface scratches for holofoil/chrome cards, or modifying edge weights for vintage paper stocks) without retraining or altering the underlying vision models.
- **Integrity rule (amended Sept 2026):** A sub-grade that was not measured is excluded, never filled with a default value. A final grade is only produced when the required sub-grades have been measured. Otherwise the result shows "—".

### Module E: Card Identification & Catalog (added Sept 2026)

- **Current:** On-device OCR reads printed text (brand, year) from the captured card and matches it against a strict set-family table. There is no fuzzy guessing and no third-party vision API. Unmatched cards are shown as "Unidentified."
- **Full market catalog:** Identification of every card on the market (players, sets, parallels, variations) and market pricing will come from **licensed catalog and pricing data sources**, as a separate data and business track.
- Identification unlocks borderless-card centering (set templates), accurate valuation, and marketplace exports.

---

## 5. TARGET MARKET & SCALABLE MONETIZATION STRATEGY

### Target Audience Segments

- **The Elite Alternative-Asset Investor:** High-end collectors requiring hyper-precise, repeatable metrics to confidently negotiate five- and six-figure raw asset acquisitions.
- **The Everyday Collector / Hobby Flipper:** Retail users scanning raw card inventory to determine whether a card is mathematically viable for physical laboratory submission.
- **Bulk Brick-and-Mortar Shop Owners:** Local card shops and high-volume dealers who manage vast raw inventories and require immediate, standardized, batch-condition tagging for showcases.
- **TCG Players:** Active gamers requiring instantaneous condition tags (Near Mint to Damaged) to generate automated marketplace listings.

### Monetization Model

**Tier 1: Free Tier (The Ecosystem Hook)**

- Full access to the core user interface and basic card inventory digital wallet.
- A limited allocation of basic automated card scans per month.
- Ad-supported revenue or basic community market valuation comparisons.

**Tier 2: Premium Collector (The Engine Subscription)**

- Unlimited high-proficiency scans featuring granular visual overlay reports, including the measured-border centering overlay that shows the collector exactly how the card was measured.
- Advanced multi-angle surface analysis via the Condition Sweep protocol.
- Multi-device cloud synchronization (iPhone, iPad, desktop web) with real-time premium market price guide integration.
- In-app subscriptions via Apple's StoreKit on iOS.

**Tier 3: Enterprise / Shop Owner (High-Volume Processing)**

- Bulk processing pipelines compatible with high-speed sheet-fed document scanners for immediate inventory batch ingestion.
- Automated CSV, JSON, and data manifest exports tailored for direct ingestion into global marketplaces (eBay, TCGPlayer, Shopify shops).

### Competitive Differentiators (added Sept 2026)

- **Transparency:** The labs' grades are a black box. "The Judge" shows its work: where each border was measured, the resulting ratios, and which sub-grades were measured.
- **Honesty:** Unmeasured values are shown as "—", never guessed. Trust is the product.
- **Proven accuracy:** Predicted-vs-actual PSA results from real submissions (Section 9) become published evidence of accuracy.
- **Hardware evolution:** The app automatically improves as users upgrade their phones.

---

## 6. MOBILE INTERFACE & FUTURE-PROOF IMPLEMENTATION (amended Sept 2026)

The technical vision is optimized for iPhone first, with Android as a later project, using an **Edge-Cloud Hybrid Architecture** designed to scale with progressive hardware updates.

```
       [ NATIVE MOBILE CAPTURE CLIENT ]                  [ CLOUD SERVER BACKEND ]
┌───────────────────────────────────────┐       ┌───────────────────────────────────────┐
│ • Session exposure / white-balance    │       │ • Validates card corners, perspective │
│   lock; full-resolution stills        │       │   correction, measurement in mm       │
│ • Detects device capabilities         │       │ • Runs all grading metrology & ML     │
│   (resolution, RAW, depth/LiDAR)      │ ───►  │ • Calculates legacy-lab formulas      │
│ • Card corner detection & crop only   │       │ • Versioned engine; archive re-grade  │
│ • UI overlays, tilt-sweep guidance    │       │ • Single grading authority            │
│ • NO grading computation on-device    │       │                                       │
└───────────────────────────────────────┘       └───────────────────────────────────────┘
  (Controls capture quality at source)            (Infinitely Upgradable & Self-Learning)
```

### Why native capture (amended Sept 2026)

The original plan called for a universal mobile-web frontend. Testing proved that mobile web browsers only expose an already-processed video preview. They offer no usable exposure lock, no full-resolution still capture, and no RAW access. These are hard platform limits, not bugs that code can fix. Camera capture therefore moved to a native iOS app. The web dashboard remains for reporting, diagnostics, and desktop access.

### Device-Adaptive Capture (amended Sept 2026)

- At runtime, the app detects what each phone supports: maximum photo resolution (e.g., 48MP on recent iPhones), RAW/ProRAW, HEIF, depth/LiDAR (for card flatness and warp), lens options, and stabilization. Larger photo sizes and RAW are adopted only when the test deck shows they improve results. Until then, capture stays at 12 MP JPEG.
- Every scan records its metadata: device model, OS version, lens, resolution, exposure/ISO/white balance, capture mode, and app + engine version.
- All geometry is stored in millimeters, so higher-resolution hardware increases precision without changing grading rules or requiring app rewrites.

### On-Device Core Safety

All grading logic, vision models, and target-lab algorithms stay server-side on cloud infrastructure. The device only controls capture and locates the card. This protects proprietary IP from reverse-engineering, allows instant backend refinements, and keeps grading consistent across all devices. The production cloud provider is to be selected. Development currently runs on a local Mac server.

### Hardware Evolution Scaling

As camera sensors and mobile processors improve, the capture client can use the new capabilities. Larger photo sizes and RAW are adopted only when the test deck shows they improve results. Grading rules stay the same.

---

## 7. ENGINEERING ROADMAP & SYSTEM LIFE-CYCLE (amended Sept 2026)

**Phase 1: Interactive Core Blueprint & Spatial Routing (Complete)**

- Responsive web interfaces for iPhone, iPad, and legacy desktop browsers.
- Navigation routing, dashboard tiles, onboarding flows, and camera upload triggers via an Express backend on port 5000.

**Phase 2: Camera Interface & Boundary Centering Sandbox (Complete)**

- Web camera viewport with card framing guides.
- Server-side grading engine (`services/grading_engine.js`).
- Discovery that web capture cannot control exposure, leading to the native-capture decision.

**Phase 2B: Native Capture & Honest Centering (Current, largely complete)**

- Native iOS capture app delivered via TestFlight (Xcode Cloud builds): session exposure lock, full-resolution stills, on-device card corner detection.
- Server as single grading authority. Perspective-corrected card measurement.
- Removal of all placeholder/mock data. Unmeasured values show "—".
- Robust bordered-card centering with measurement overlays and diagnostics. Validated on real scans.
- Remaining: higher-resolution sub-pixel centering in millimeters; validation across the full test deck.

**Phase 3: Defect Detection Rebuild & Calibration (Next Horizon)**

- Rebuild and validate the corner, edge, and surface detectors on real worn cards and the test deck. Promote Condition Sweep data into surface scoring once validated.
- Calibrate the Predictive Legacy Tier against real PSA outcomes from pre-submission scans.
- Launch the target-lab predictor profiles (PSA eye-appeal model vs. BGS sub-grade matrix vs. SGC vintage guidelines).
- Deploy the user-verification feedback loop, allowing trusted power-users to flag incorrect outputs into the ML registry.

**Phase 4: Production Infrastructure & Catalog**

- Move the backend from the development server to production cloud hosting: user accounts and authentication, secure storage, privacy and consent controls.
- Integrate licensed card catalog and pricing data. Borderless-card centering via set templates.

**Phase 5: Launch**

- StoreKit subscriptions, external TestFlight beta, App Store review, public release.
- Android capture client after iOS is proven.

---

## 8. ABSOLUTE EXECUTION GUIDELINES FOR THE AI CO-DEVELOPER

Every AI assistant, developer, and engineer contributing to this repository must follow these mandates:

1. **Maintain Universal Accessibility & Performance:** Web frontend logic uses fluid, native CSS/HTML layouts that never break on mobile touch viewports or older desktop browsers, with light client-side scripts. *(Amended Sept 2026: camera capture is a native Swift iOS app; this mandate applies to the web dashboard and reporting.)*
2. **Uphold Absolute Modular Isolation:** Keep the architecture completely decoupled. Write helper engines, metrology scripts, and API routes into distinct, isolated directories. Never combine UI presentation, database logic, and image-processing calculations into single massive scripts.
3. **Document with Explicit Intent:** Every function, algorithm, and formula must include structured comments defining its purpose, parameters, and downstream dependencies.
4. **Never Fabricate a Result (added Sept 2026):** No placeholder, mock, random, or default value may ever be shown or saved as a real measurement, identification, grade, or price. If it wasn't measured, it shows "—". Detectors that aren't validated are disabled and reported as "not measured."
5. **Prove Before Merging (added Sept 2026):** Every grading-engine change must be tested on real archived scans and the test deck (e.g., via `compare_finders.js`) and shown to be equal or better before it is merged. Report branches and commit hashes for every merge.
6. **Measure in Physical Units (added Sept 2026):** Store and compare geometry in millimeters, never in device-dependent pixels, so the engine stays device-independent.

---

## 9. VALIDATION, GROUND TRUTH & RELEASE DISCIPLINE (added Sept 2026)

### The Test Deck

A fixed benchmark set of about 40–50 real cards (labeled TD-01 to TD-50) is kept permanently unchanged, so every engine version is measured against the same cards. It spans:

- White borders: vintage (1950s–70s), 1980s–90s, modern
- Colored borders
- Borderless / full-bleed (must report "undetectable" honestly until Track 2 exists)
- Chrome / refractor / foil
- Die-cut / odd shapes
- TCG: Pokémon, Magic: The Gathering
- Visibly off-center cards (must be caught as off-center)
- Worn cards: soft corners, edge wear, creases (for the defect detector rebuild)

A deck report shows, per card and per category, measured vs undetectable, centering results, sub-grades, and engine version, compared with the previous engine. It serves as a release gate alongside archive back-testing.

### PSA Ground Truth

Every card sent to PSA is scanned **before submission**, and the returned grade is recorded. Each submission becomes a labeled predicted-vs-actual example. This builds:

- The calibration data for the Predictive Legacy Tier.
- Published evidence of accuracy for customers and investors.
- Training data for the ML flywheel.

### Data & Privacy

Scans (originals, metadata, results, engine version) form the ML flywheel dataset. Privacy and consent requirements must be defined and implemented before public launch.

---

## 10. AMENDMENT LOG

**September 2026**

- **Section 1:** Added the measurable reproducibility standard; updated the pipeline diagram for native capture and versioned learning.
- **Section 2:** Added how the living continuum is implemented (engine versioning, archived originals, back-testing release gate, device-adaptive evolution).
- **Section 3:** Documented the current PSA centering calibration (strict end) and the open 100-point vs 0–10 scale reconciliation.
- **Section 4, Module A:** Replaced "restore processed images" with "control capture at the source"; added millimeter measurement.
- **Section 4, Module B:** Added the current status of each detector. Centering is live. Edge, corner, and surface are disabled pending rebuild, because the first-generation detectors misread white borders as wear. The Condition Sweep is implemented as a multi-angle still sweep, diagnostic-only.
- **Section 4, Module D:** Added the rule that unmeasured sub-grades are excluded, never defaulted.
- **Section 4, Module E:** New section on card identification and the licensed catalog strategy.
- **Section 5:** Added competitive differentiators; StoreKit subscriptions.
- **Section 6:** Changed to native iOS capture with device-adaptive hardware use; the web dashboard remains. Explained why web capture was not viable.
- **Section 7:** Updated roadmap phases and statuses.
- **Section 8:** Added mandates 4–6 (never fabricate, prove before merging, measure in physical units).
- **Section 9:** New section on the test deck, PSA ground truth, and data/privacy.

**September 29, 2026**

- **Section 1:** Replaced the 1.6-point repeatability figure with the current hi-res result on 12 real scans: 0.7 points left/right and 0.4 points top/bottom.
- **Sections 2, 4, and 6:** Larger photo sizes and RAW are adopted only when the test deck shows they improve results. Capture stays at 12 MP JPEG until then.
