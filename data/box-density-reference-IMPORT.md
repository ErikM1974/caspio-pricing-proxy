# Box-Density Reference — Caspio import (optional, tunable config)

`box-density-reference.csv` = outbound **pieces-per-box by garment category**, used by the
embroidery shipping estimator to count boxes (boxes ≈ ceil(order qty ÷ pieces-per-box)).
The numbers are data-backed (real SanMar inbound cartons + a decorated-bulk shave) and bias
HIGH on purpose (so the customer prepays enough freight — never a second card charge).

## How it's used
- The estimator calls **`GET /api/shipping/box-density`** (proxy `src/routes/shipping.js`).
- That endpoint returns the **Caspio `Box_Density_Reference` table if it exists**, otherwise
  the hardcoded defaults baked into the route. So **it already works with the defaults — the
  Caspio table is OPTIONAL** and only needed if you want to TUNE the numbers without a deploy.

## To make it tunable (one-time, in the Caspio UI)
1. Create a table named **`Box_Density_Reference`** (Tables → New Table → Import from CSV).
2. Import `box-density-reference.csv`. The only two columns the code reads are:
   - **`Category`** (Text) — must match: `Cap`, `T-Shirt`, `Polo`, `Sweatshirt`, `Hoodie`,
     `Jacket`, `Outerwear`.
   - **`PiecesPerBox`** (Number) — outbound pieces per box for that category.
   The other columns (DecoratedFactor, FullCartonPieces, AvgWeightLb, TypicalCaseSize,
   DataBasis, SampleSize) are documentation only — keep them or drop them, the code ignores them.
3. Done. Edit `PiecesPerBox` any time in Caspio and the estimator picks it up (no deploy).
   e.g. if real decorated jackets run tighter, drop Jacket from 17 → 14.

## What's NOT here (and why)
- **Per-style weight + case pack** — already live in Caspio's SanMar catalog (`/api/inventory`
  `PIECE_WEIGHT`/`CASE_SIZE`); the estimator reads it directly. Don't duplicate it (it'd rot).
- **Box dimensions** — NO SanMar service returns carton L/W/H. A true dimensional model needs
  us to log our own outbound boxes (see below).
- **Carton weight** — the PromoStandards **ASN** the proxy uses (`sanmar-shipments.js`) does NOT
  return per-box weight, so the estimator computes carton weight = per-piece weight × qty. BUT
  note (corrected 2026-06-07): SanMar's separate **License Plate Number / GetPackingSlip** service
  DOES return a real per-box `Weight` + `ShipmentUnitIndex` (box #) + the items in the box. It's
  scan-keyed (post-ship, by LPN barcode only), so it's a future CALIBRATION source — scan inbound
  cartons at receiving to ground-truth pieces-per-box + weight — not a pre-ship lookup. Details:
  `Pricing Index/memory/freight-estimator-details.md`.
- **True measured decorated density** — would require logging OUR outbound boxes (box → contents);
  not captured today. Future upgrade: extend the Box Labels feature to log outbound, then re-derive.
