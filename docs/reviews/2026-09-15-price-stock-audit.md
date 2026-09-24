# Price, unit conversion and inventory audit

Date: 15 September 2026

**Follow-up, 20 September:** stock checks with an explicit late-restock exception, return limits, cancellation protection and cumulative gross/net return-cost allocation have now been implemented. See [implementation and operator notes](2026-09-20-restock-and-return-safety.md). The findings below record the original audit; legacy cost reporting and general numeric limits remain separate work.

## Assessment

Ordinary whole-unit sales and supplier receipts convert correctly in the tested cases. The core design is sound: quantities use a product's smallest unit and money uses integer pesewas. This is not yet an unconditional clean bill of health. Cart editing and customer-return defects were fixed during this review; other stock-control and return-value risks remain below.

This review used real service functions, all migrations, and disposable in-memory SQLite databases. No shop database was changed. Printers were mocked where sale printing was exercised. This verifies application arithmetic and database writes, not the accuracy of a shop's configured pack sizes or physical counts. The installed shop's accounting mode was not inspected.

## Simulation

Product units: bottle = 1, pack = 6 bottles, crate = 24 bottles. Selling prices: bottle GHS 8, pack GHS 45, crate GHS 180. Purchase costs: crate GHS 100, pack GHS 25.01, bottle GHS 4.17.

| Step | Calculation | Expected and observed bottles |
|---|---|---:|
| Receive 10 crates | 10 × 24 | 240 |
| Sell 2 crates, 3 packs, 5 bottles | 240 − (48 + 18 + 5) | 169 |
| Receive 2 crates | 169 + 48 | 217 |
| Receive 1 pack | 217 + 6 | 223 |
| Cancel the mixed sale | 223 + 71 | 294 |
| 60 varied receive/sell cycles | Every receipt's units sold back out | 294 |
| Sell the remainder as bottles | 294 − 294 | 0 |

The mixed sale total was exactly 2 × 180 + 3 × 45 + 5 × 8 = **GHS 535.00**. Each database balance was compared with an independent integer-count model after each transaction. The simulation ran with ledger posting both disabled and enabled. In ledger mode, the final valuation balance also reached exactly zero. An extra sale after reaching zero was rejected in ledger mode, but accepted in non-ledger mode, leaving −1 bottle (a documented remaining policy gap).

## What was fixed

1. **Mixed-unit cart row identity.** Quantity buttons, deletion, unit switching and tier application previously matched only product ID. A bottle action could edit or reprice a crate row of the same product. Actions now target product plus unit, React keys include the unit, and switching to an existing unit merges into its row. Tier lookup now reruns when the unit, factor or base price changes.
2. **Return cost divided twice.** Product cost is already per smallest unit. The return service divided it by the crate factor again. At GHS 6 per bottle, a 24-bottle crate was valued at GHS 6 instead of GHS 144 in the fallback path. It now uses canonical cost directly; ledger-linked returns continue to use their existing exact-cost restoration path.
3. **Wrong product's return unit.** A return could use another product's unit/factor. The service now rejects that mismatch before writing stock.

Regression tests cover these fixes. Both return regressions failed before the fix and passed afterward.

## Rounding and price semantics

- Stock conversion is quantity × integer unit factor. There is no division or rounding of physical bottle counts. Fractional quantities are rejected in the sale and receipt services; enter a partial crate as whole bottles instead.
- Supplier invoices preserve quantity × purchase-unit cost. GHS 100 for 24 bottles remains exactly 10,000 pesewas even though its displayed per-bottle cost rounds from 416.666… to 417 pesewas.
- With ledger posting enabled, outgoing valuation takes a rounded slice of the remaining value pool. Selling the final units consumes the entire remaining value, avoiding residual value on zero stock. Full-sale cancellation and full returns restore the exact tested outflow value.
- Without ledger posting, sales use the rounded latest-receipt per-bottle cost. Selling 240 bottles from GHS 1,000 of stock at a rounded cost of 417 pesewas records GHS 1,000.80 in COGS. This affects cost/profit, not bottle counts. Latest-receipt cost and moving-average accounting cost are distinct concepts in this application.
- Wholesale/route unit prices scale the configured unit price by the channel-to-walk-in price ratio, round once per selling unit, then multiply by quantity. Example: 4,500 × 733 / 800 = 4,123.125 → 4,123 pesewas per pack. A crate may intentionally cost less than the equivalent number of loose bottles.
- Volume tiers are evaluated per cart line using canonical quantity, not the combined quantity of all unit rows for that product. Cross-unit volume aggregation would be a separate pricing-policy change.

## Remaining findings, in priority order

### High: original-sale return limits are missing

`customerReturns.ts` does not cap cumulative returned canonical quantity against the referenced original sale. Supervisor approval is required, but it does not prevent duplicate/over-returns. The existing customer-return suite already has TODO coverage for the cap. Receipt-less returns are also explicitly supported.

Recommended correction: validate the original sale/customer/location/status; sum previously returned canonical quantities by product; reject cumulative excess in the same transaction. Handle receipt-less returns as an explicit exception. Check cancellation after partial returns to prevent double restocking.

### High: overselling differs by accounting mode

Non-ledger sales do not enforce an available-stock check in the transaction. The simulation confirmed a sale at zero stock produces −1. Ledger valuation rejects the same transaction. Thus integer conversion alone cannot guarantee a non-negative stock count.

Recommended correction: define one consistent oversell policy and enforce the aggregate quantity across all unit rows, per product/location, inside the sale transaction. If deliberate negative-stock selling is needed, make it an explicit approved exception rather than an accounting-mode side effect.

### Medium: separate partial returns can accumulate value-rounding error

Confirmed with a real ledger-mode sale: sell a crate whose cost is 10,000 pesewas, then return it in three batches of eight bottles. Each return restores round(10,000 × 8 / 24) = 3,333 pesewas. All 24 bottles return correctly, but only 9,999 pesewas return to inventory. The valuation pool ends at 240 bottles / 99,999 pesewas instead of 100,000 pesewas.

Recommended correction: allocate against cumulative returned quantity/value and assign the exact remaining cost to the final return. This should be implemented together with cumulative quantity limits. The characterization test documents the current shortfall; its passing status does not mean the behavior is correct.

### Medium: non-ledger cost estimates can drift

Rounded per-unit latest-receipt cost is not an exact allocation of invoice cost. This does not alter stock quantities but can distort margins, especially over many units or changes in purchase price. Do not silently switch an existing installation's accounting mode. Use exact value allocation for accounting or clearly distinguish estimated cost in reports.

### Low under realistic shop volumes: safe-number bounds are incomplete

Several services use `Number.isInteger`, which accepts integers beyond JavaScript's exact safe range, and multiplication/accumulation is not consistently bounded. Money parsing can also accept impractically large values. Realistic shop transactions are well below this range, but malformed input/imports deserve protection.

Recommended correction: enforce safe integers and practical limits at input boundaries and check computed quantity/value totals. For proportional cost allocation, exact integer numerator/remainder arithmetic avoids large intermediate-product precision loss.

## External research

- SQLite explains that binary floating-point values are approximate and should not be used when exact answers are required: https://www.sqlite.org/floatingpoint.html
- JavaScript's safe integer range and why integer validation alone is insufficient: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isSafeInteger
- SQLite type affinity is not a substitute for application validation: https://www.sqlite.org/datatype3.html

The existing integer-pesewa/integer-smallest-unit architecture follows this guidance. The most immediate stock-count risks found here arise from row identity and business validation, rather than normal-size multiplication rounding.

## Verification

Tests cover mixed-unit sales, supplier receipts, product-unit validation, channel/tier prices, discounts, stocktake conversion, returns, cancellation, exact ledger COGS, money parsing and Friendly checkout regression behavior. New tests are in `tests/cart-mixed-units.test.ts` and `tests/unit-stock-simulation.test.ts`, with additional return checks in the existing return suites.

The three existing TODO tests in the customer-return suite are unfinished coverage, not passed acceptance checks. Characterization tests for negative stock and partial-return rounding intentionally expose remaining behavior.

Final verification: **244 tests passed across 17 files; 3 existing TODO tests remain.** `npm run typecheck`, `npm run build:friendly`, and `git diff --check` passed. The build retains its existing large-chunk warning. These results do not close the remaining findings above.
