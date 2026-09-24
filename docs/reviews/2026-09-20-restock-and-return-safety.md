# Late restock and return safety

## Using the till

Sales normally check the total number of smallest units needed across all cart rows for each product. If a crate and loose bottles together exceed the recorded stock, saving is refused and the cart stays available for correction.

If the goods are physically present but the delivery has not been entered, select **Restock not recorded yet** before taking payment. This is an explicit per-sale exception, available to signed-in selling staff and recorded in the audit log. It resets for the next sale. The acknowledgement is passed through both ordinary and split checkout.

Example: recorded stock 0; sell 6 bottles with the acknowledgement → recorded balance −6. Enter the actual full delivery of 24 bottles later → balance 18. Enter the delivery quantity, **not just the unsold remainder**. Sales are already deducted; the receipt is added once. Partial receipt entries can leave a shortfall until the rest is entered.

The stock check and the sale writes run in the same immediate SQLite transaction. A second till must check the latest committed balance even when its screen still displays the previous count.

## Accounting while restock is pending

With ledger posting enabled, a negative stock balance carries an estimated cost based on the current recorded cost. Late receipts settle the shortage, value any surplus at receipt cost, and post a separately identifiable `LATE_RESTOCK_COST` journal for the difference. A receipt that exactly covers the shortage leaves both quantity and valuation at zero.

Historical sale-line cost snapshots are not rewritten. The financial ledger includes subsequent cost adjustments; a report based only on original sale-line margins may differ from the financial statements. Full replacement of legacy rounded-cost reporting remains the separate accounting-reconciliation work described as step 4 in the earlier plan.

Without ledger posting, quantity reconciliation is the same, but the existing latest-receipt rounded-cost reporting remains in effect. No installation's accounting mode is automatically switched.

## Returns and cancellations

- Choose the original sale in the return form. Missing-receipt returns require an explicit checkbox and supervisor approval and are identified in the audit log. The form lists the latest 100 sales; older or missing receipts need the approved exception workflow.
- A linked return checks the original sale's customer (when recorded), location and cancellation status. Pending cancellation requests must be resolved first.
- Across all previous returns and all rows in the current return, quantities cannot exceed the original product's sold quantity, converted to smallest units using the stored movements.
- Total refunds cannot exceed the amount remaining from the original sale, including its discount.
- Cost allocation uses cumulative integer arithmetic. The final return receives the remaining pesewas. VAT builds also store the allocated net-cost share so partial returns do not independently round the same cost repeatedly.
- A sale with any linked return cannot subsequently be cancelled or replaced through the sale-correction void path. Return its remaining eligible items instead.
- Return writes, money effects and audit records commit or roll back together under an immediate transaction.

These controls cannot prevent an intentionally misclassified receipt-less return or an incorrect physical delivery quantity. Supervisor review and physical stock counts remain necessary operational checks.

## Upgrade

Migration `0055_deferred_restock_valuation.sql` permits signed valuation balances and adds a nullable net-cost snapshot to return lines. It preserves existing valuation records and insertion order, recreates the sync trigger, and does not recalculate historical shop transactions. The standard migration runner applies it at startup. Back up each installation before installing an upgrade, using `--variant friendly` for Counter Friendly.

## Verification coverage

- Mixed crate/pack/bottle arithmetic; 60 repeated receive/sell cycles in each accounting mode.
- Default refusal and acknowledged shortfalls; partial, exact and surplus late receipts; a differing actual receipt cost; inventory account versus valuation pool.
- Two database connections using stale displayed stock: only the first ordinary sale can consume the last bottle; the second needs explicit acknowledgement.
- Cancellation before restock restores a zero balance.
- Excess returns, cumulative returns, duplicate product rows, excessive refunds and cancellation/return exclusion.
- Three eight-bottle returns against a 24-bottle crate restore its exact gross and net cost.
- Migration preserves old rows without producing duplicate sync events.
- Checkout acknowledgement is transmitted and cleared after completion.

### Completed verification

- Default full suite: **812 passed**, 11 conditionally skipped.
- VAT-specific and stock/return checks: **43 passed**, one no-VAT-only test skipped.
- Both opt-in performance suites: **4 passed**, using 100,000-sale fixtures. These cover the four performance tests skipped in the default suite; the VAT run covers the seven VAT-only defaults.
- TypeScript, standard build, VAT build, Friendly build and whitespace checks passed. Existing bundle-size warnings remain.
- All simulations used disposable test databases. No live shop database was migrated or modified by this work.
