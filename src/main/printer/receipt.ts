// Re-export of the shared receipt module. The formatter and types live in
// src/shared/lib/receipt.ts so the renderer can import them too (for the
// optional on-screen Print Receipt flow). Main-side callers continue to
// import from this path for backward compatibility.

export type {
  ReceiptLine,
  ReceiptPayment,
  ReceiptTender,
  SaleReceipt,
} from '../../shared/lib/receipt.js';
export { formatReceipt, renderReceiptText } from '../../shared/lib/receipt.js';
