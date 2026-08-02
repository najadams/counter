// Typed IPC contracts. Renderer -> main only.

export const IPC_CHANNELS = {
  // System
  PING: 'system:ping',
  GET_DEVICE_ID: 'system:device-id',
  NET_ACCESS_INFO: 'system:access-info',
  NET_HTTP_STATUS: 'system:http-status',
  NET_HTTP_SET: 'system:http-set',

  // Auth / session
  WORKER_LIST_FOR_LOGIN: 'worker:list-for-login',
  WORKER_LOGIN: 'worker:login',
  WORKER_VERIFY_CURRENT_PIN: 'worker:verify-current-pin',
  WORKER_LOGOUT: 'worker:logout',
  WORKER_GET_CURRENT: 'worker:get-current',

  // Shifts
  SHIFT_OPEN: 'shift:open',
  SHIFT_GET_OPEN: 'shift:get-open',
  SHIFT_SUBMIT_COUNT: 'shift:submit-count',
  SHIFT_CLOSE: 'shift:close',

  // Sales
  PRODUCT_SEARCH: 'product:search',
  PRODUCT_GET_STOCK: 'product:get-stock',
  CUSTOMER_SEARCH: 'customer:search',
  SALE_COMPLETE: 'sale:complete',
  SALE_REPRICE_LINES: 'sale:reprice-lines',
  PAPER_RECEIPT_CREATE: 'paper-receipt:create',
  PAPER_RECEIPT_LIST: 'paper-receipt:list',
  PAPER_RECEIPT_GET: 'paper-receipt:get',
  PAPER_RECEIPT_UPDATE: 'paper-receipt:update',
  PAPER_RECEIPT_REPARSE: 'paper-receipt:reparse',
  PAPER_RECEIPT_RESOLVE_FOR_CART: 'paper-receipt:resolve-for-cart',
  PAPER_RECEIPT_MARK_POSTED_FROM_TILL: 'paper-receipt:mark-posted-from-till',
  PAPER_RECEIPT_POST: 'paper-receipt:post',
  PAPER_RECEIPT_DISCARD: 'paper-receipt:discard',

  // Voids
  SALE_LIST_RECENT: 'sale:list-recent',
  SALE_VOID_REQUEST_CREATE: 'sale:void-request-create',
  SALE_VOID_REQUEST_LIST: 'sale:void-request-list',
  SALE_VOID_REQUEST_GET: 'sale:void-request-get',
  SALE_VOID_REQUEST_REVIEW: 'sale:void-request-review',
  SALE_VOID_REQUEST_WITHDRAW: 'sale:void-request-withdraw',
  SALE_VOID_REQUEST_PENDING_COUNT: 'sale:void-request-pending-count',
  SALE_CORRECT: 'sale:correct',

  // Breakage / consumption / stock receipts
  BREAKAGE_REPORT: 'breakage:report',
  BREAKAGE_LIST_RECENT: 'breakage:list-recent',
  CONSUMPTION_LOG: 'consumption:log',
  CONSUMPTION_GET_USAGE: 'consumption:get-usage',
  STOCK_RECEIVE: 'stock:receive',
  SUPPLIER_LIST: 'supplier:list',

  // Worker admin
  WORKER_ADMIN_LIST: 'worker:admin-list',
  WORKER_ADD: 'worker:add',
  WORKER_DEACTIVATE: 'worker:deactivate',
  WORKER_REACTIVATE: 'worker:reactivate',
  WORKER_TERMINATE: 'worker:terminate',
  WORKER_CHANGE_PIN: 'worker:change-pin',
  WORKER_RESET_PIN: 'worker:reset-pin',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type IpcResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// --- system ----------------------------------------------------------------

export interface PingRequest { echo?: string }
export interface PingResponse { pong: true; echo: string | undefined; serverTime: string }
export interface GetDeviceIdResponse { deviceId: string }
/** How a phone/tablet on the LAN can reach this host, for the home-screen
 *  "scan to join" QR. `exposed` is false unless the embedded server is bound
 *  to the LAN (COUNTER_HTTP_HOST=0.0.0.0). */
export interface AccessInfoResponse {
  exposed: boolean;
  scheme: 'http' | 'https';
  port: number;
  /** Reachable IP URLs, e.g. ['http://192.168.1.20:4317']. Empty when not exposed. */
  urls: string[];
  /** Stable mDNS URL (http://counter.local:PORT) when advertised. */
  mdnsUrl?: string;
}

/** Runtime state of the embedded LAN server (the "Phone access" toggle). */
export interface HttpStatusResponse {
  enabled: boolean;
  host: string;
  access: AccessInfoResponse | null;
}
/** Toggle phone access. `lan` exposes on the LAN (0.0.0.0); default true. */
export interface HttpSetRequest { enabled: boolean; lan?: boolean }

// --- auth ------------------------------------------------------------------

export interface ListLoginCandidatesResponse {
  workers: Array<{ id: string; fullName: string; role: string }>;
}
export interface WorkerLoginRequest { workerId: string; pin: string }
export interface WorkerVerifyCurrentPinRequest { pin: string }
export type WorkerLoginResponse =
  | { ok: true; workerId: string; fullName: string; role: string }
  | { ok: false; reason: 'INVALID_PIN'; attemptsRemaining: number }
  | { ok: false; reason: 'LOCKED_OUT'; lockedUntil: string }
  | { ok: false; reason: 'UNKNOWN_WORKER' }
  | { ok: false; reason: 'SYSTEM_ROLE_REJECTED' };
export type WorkerVerifyCurrentPinResponse = WorkerLoginResponse;
export interface WorkerLogoutResponse { ok: true }
export type WorkerGetCurrentResponse =
  | { workerId: string; fullName: string; role: string }
  | { workerId: null };

// --- shifts ----------------------------------------------------------------

export interface ShiftOpenRequest {
  openingCashPesewas: number;
  shiftType: 'COUNTER' | 'ROUTE';
}
export interface ShiftOpenResponse { shiftId: string }
export type ShiftGetOpenResponse =
  | { open: true; shiftId: string; openedAt: string; openingCashPesewas: number; totalSalesPesewas: number }
  | { open: false };
export interface ShiftSubmitCountRequest { shiftId: string; countedPesewas: number }
export interface ShiftSubmitCountResponse { cashCountId: string }
/**
 * Result of the auto-backup that runs after a 'last close of the day'.
 * Always present in ShiftCloseResponse; `ran: false` means the trigger
 * conditions weren't met (e.g. close happened before END_OF_BUSINESS_DAY_HOUR
 * or a backup already ran today). `ran: true, ok: false` means we tried
 * and it failed — the shift is still closed, but the cashier should see a
 * warning so they can resolve the underlying issue (USB unplugged, etc.).
 */
export interface ShiftCloseBackupResult {
  ran: boolean;
  /** Why we didn't run, when ran=false. e.g. 'before-cutover', 'already-today'. */
  skippedReason?: 'before-cutover' | 'already-today' | 'disabled';
  /** Whether the backup write succeeded, when ran=true. */
  ok?: boolean;
  /** Destination .db path on success. */
  dbDest?: string;
  /** Target directory the backup was written to. */
  target?: string;
  /** True if the configured target was unwritable and we fell back to ~/CounterBackups. */
  fellBackToDefault?: boolean;
  /** Size of the written .db in bytes. */
  sizeBytes?: number;
  /** Error message if ran && !ok. */
  error?: string;
}

export interface ShiftCloseRequest { shiftId: string }
export interface ShiftCloseResponse {
  shiftId: string;
  countedPesewas: number;
  expectedPesewas: number;
  variancePesewas: number;
  totalSalesPesewas: number;
  totalBreakageValuePesewas: number;
  /** Auto-backup result. Always populated. See ShiftCloseBackupResult. */
  backup: ShiftCloseBackupResult;
}

// --- sales -----------------------------------------------------------------

export type SaleChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export interface ProductSearchRequest { query: string; channel: SaleChannel; limit?: number }
// Unit fields come from product_units (migration 0029): defaultUnitId is the
// smallest active sellable unit; defaultUnitFactor converts display-unit
// quantities to canonical for stock movements; canonicalChannelPricePesewas
// is the per-canonical-unit price at the requested channel. The renderer
// MUST round-trip these into the cart line — sales.ts uses them to scale
// stock_movements quantities correctly. See SaleScreen.tsx addHitToCart.
export interface ProductSearchResponse {
  products: Array<{
    id: string; sku: string; barcode: string | null; name: string; brand: string | null; category: string;
    unitPricePesewas: number; costPricePesewas: number; unitsOnHand: number; isReturnable: boolean;
    defaultUnitId: string | null;
    defaultUnitName: string;
    defaultUnitFactor: number;
    canonicalChannelPricePesewas: number;
  }>;
}
export interface ProductGetStockRequest { productId: string }
export interface ProductGetStockResponse { unitsOnHand: number }

export interface CustomerSearchRequest { query: string; limit?: number }
export interface CustomerSearchResponse {
  customers: Array<{
    id: string; displayName: string; phone: string; customerType: string;
    currentBalancePesewas: number; creditLimitPesewas: number; blocked: boolean;
    cashOnly: boolean;
    preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  }>;
}

export interface SaleTenderInput {
  method: string;                       // 'CASH' | 'MOMO_*' | 'CREDIT' | 'BANK_TRANSFER'
  amountPesewas: number;                // > 0
  reference?: string | null;            // MoMo / bank ref
  cashGivenPesewas?: number | null;     // CASH only — supports overpay + change
}

export interface SaleCompleteRequest {
  shiftId: string;
  channel: SaleChannel;
  lines: Array<{ productId: string; quantity: number; unitPricePesewas: number; unitId?: string | null }>;
  discountPesewas?: number;
  discountReason?: string | null;
  /** Required when discount crosses the threshold. */
  supervisorWorkerId?: string | null;
  supervisorPin?: string | null;

  // Payment: either `payments[]` (split-tender) OR the legacy single-tender
  // shortcut (paymentMethod + paymentReference + cashGivenPesewas).
  payments?: SaleTenderInput[];
  paymentMethod?: string;
  paymentReference?: string | null;
  cashGivenPesewas?: number | null;

  customerId?: string | null;
}
export interface SaleCompleteResponse {
  saleId: string;
  totalPesewas: number;
  changePesewas: number | null;
  printerFailed: boolean;
  printerError?: string;
  /** Print station this sale routed to ('door' = phone/LAN, 'counter' = desktop).
   *  The renderer escalates a door-printer failure into a blocking alert. */
  station: 'counter' | 'door';
  /** Receipt struct the renderer can render for on-screen / browser-print. */
  receipt: import('../lib/receipt.js').SaleReceipt;
}

// Re-price an existing cart's lines for a new channel — no clearing,
// no quantity changes, just fresh per-unit prices for the new channel.
export interface SaleRepriceLinesRequest {
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  lines: Array<{
    productId: string;
    unitId: string | null;
  }>;
}
export interface SaleRepriceLinesResponse {
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  lines: Array<{
    productId: string;
    unitId: string | null;
    unitPricePesewas: number;
  }>;
}

// --- paper receipt import --------------------------------------------------

export type PaperReceiptStatus = 'REVIEW' | 'POSTED' | 'DISCARDED';

export interface PaperReceiptLineDraft {
  id: string;
  lineNo: number;
  rawText: string;
  productId: string | null;
  productSku: string | null;
  productName: string | null;
  unitId: string | null;
  unitName: string | null;
  quantity: number | null;
  unitPricePesewas: number | null;
  confidence: number;
  reviewNote: string | null;
}

export interface PaperReceiptSummary {
  id: string;
  status: PaperReceiptStatus;
  createdAt: string;
  workerName: string;
  channel: SaleChannel;
  paymentMethod: string;
  lineCount: number;
  matchedLineCount: number;
  totalPesewas: number;
  postedSaleId: string | null;
  tillOpenedAt: string | null;
  tillOpenedByName: string | null;
}

export interface PaperReceiptDetail extends PaperReceiptSummary {
  ocrText: string;
  photoDataUri: string | null;
  photoBytes: number | null;
  paymentReference: string | null;
  cashGivenPesewas: number | null;
  customerId: string | null;
  customerName: string | null;
  lines: PaperReceiptLineDraft[];
}

export interface PaperReceiptCreateRequest {
  photoBase64: string;
  photoExtension: string;
  ocrText: string;
  channel: SaleChannel;
  paymentMethod: string;
  paymentReference?: string | null;
  cashGivenPesewas?: number | null;
  customerId?: string | null;
}
export interface PaperReceiptCreateResponse { draftId: string }
export interface PaperReceiptListRequest { limit?: number }
export interface PaperReceiptListResponse { drafts: PaperReceiptSummary[] }
export interface PaperReceiptGetRequest { draftId: string }
export interface PaperReceiptGetResponse extends PaperReceiptDetail {}
export interface PaperReceiptUpdateRequest {
  draftId: string;
  ocrText: string;
  channel: SaleChannel;
  paymentMethod: string;
  paymentReference?: string | null;
  cashGivenPesewas?: number | null;
  customerId?: string | null;
  lines: Array<{
    rawText: string;
    productId: string | null;
    unitId?: string | null;
    quantity: number | null;
    unitPricePesewas: number | null;
    confidence?: number;
    reviewNote?: string | null;
  }>;
}
export interface PaperReceiptSimpleResponse { ok: true }
export interface PaperReceiptResolveForCartRequest { draftId: string }
export interface PaperReceiptResolveForCartResponse {
  draftId: string;
  channel: SaleChannel;
  lines: Array<{
    productId: string;
    sku: string;
    name: string;
    unitId: string | null;
    unitName: string;
    factor: number;
    unitPricePesewas: number;
    quantity: number;
    unitsOnHand: number;
  }>;
}
export interface PaperReceiptMarkPostedFromTillRequest { draftId: string; saleId: string }
export interface PaperReceiptPostRequest { draftId: string }
export interface PaperReceiptPostResponse extends SaleCompleteResponse { draftId: string }
export interface PaperReceiptDiscardRequest { draftId: string; reason: string }

// --- voids -----------------------------------------------------------------

export interface SaleListRecentRequest { limit?: number }
export interface SaleListRecentResponse {
  sales: Array<{
    id: string; createdAt: string; channel: string; totalPesewas: number;
    paymentMethod: string; workerName: string; customerName: string | null;
    voided: boolean; lineCount: number;
    voidRequest: {
      id: string;
      status: SaleVoidRequestStatus;
      reason: string;
      requestedAt: string;
      requesterId: string;
      requesterName: string;
      reviewedAt: string | null;
      reviewerName: string | null;
      reviewNote: string | null;
    } | null;
  }>;
}
export type SaleVoidRequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN';
export type SaleVoidRequestScope = 'MINE' | 'REVIEWABLE' | 'ALL';
export interface SaleVoidRequestSummary {
  id: string;
  saleId: string;
  locationId: string;
  shiftId: string;
  status: SaleVoidRequestStatus;
  reason: string;
  requestedAt: string;
  requesterId: string;
  requesterName: string;
  reviewerId: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  withdrawnAt: string | null;
  saleCreatedAt: string;
  saleWorkerName: string;
  customerName: string | null;
  channel: string;
  totalPesewas: number;
  paymentMethod: string;
  lineCount: number;
}
export interface SaleVoidRequestDetail extends SaleVoidRequestSummary {
  lines: Array<{
    productId: string;
    productName: string;
    quantity: number;
    unitName: string | null;
    unitPricePesewas: number;
    lineTotalPesewas: number;
    canonicalQuantity: number;
    inventoryValuePesewas: number;
  }>;
  payments: Array<{ method: string; amountPesewas: number }>;
  creditBalanceDeltaPesewas: number;
  accountingEffect: {
    netSalesPesewas: number;
    cogsPesewas: number;
    vatPesewas: number;
    nhilPesewas: number;
    getfundPesewas: number;
  };
}
export interface SaleVoidRequestCreateRequest { saleId: string; reason: string }
export interface SaleVoidRequestListRequest {
  scope: SaleVoidRequestScope;
  status?: SaleVoidRequestStatus | 'RESOLVED';
  limit?: number;
}
export interface SaleVoidRequestListResponse { requests: SaleVoidRequestSummary[] }
export interface SaleVoidRequestGetRequest { requestId: string }
export interface SaleVoidRequestReviewRequest {
  requestId: string;
  decision: 'APPROVE' | 'DECLINE';
  note?: string | null;
}
export interface SaleVoidRequestWithdrawRequest { requestId: string }
export interface SaleVoidRequestPendingCountResponse {
  minePendingCount: number;
  reviewablePendingCount: number;
  currentShiftPendingCount: number;
}
export interface SaleCorrectRequest {
  originalSaleId: string;
  /** ONLY the missed items; original lines are rebuilt server-side. */
  addedLines: Array<{ productId: string; quantity: number; unitPricePesewas: number; unitId?: string }>;
  /** Tenders for the FULL corrected total (must sum to it). */
  payments: Array<{ method: string; amountPesewas: number; reference?: string | null; cashGivenPesewas?: number | null }>;
}
export interface SaleCorrectResponse {
  originalSaleId: string;
  newSaleId: string;
  totalPesewas: number;
  deltaPesewas: number;
  changePesewas: number | null;
  printerFailed: boolean;
  printerError?: string;
  station: 'counter' | 'door';
}

// --- breakage --------------------------------------------------------------

export interface BreakageReportRequest {
  productId: string;
  quantity: number;
  cause: 'DROPPED' | 'CUSTOMER_ACCIDENT' | 'TRANSPORT' | 'EXPIRED_LEAK' | 'UNKNOWN' | 'OTHER';
  causeDescription?: string | null;
  /** Base64-encoded photo bytes (renderer reads file with FileReader). */
  photoBase64: string;
  /** lowercase extension without dot (jpg, png, webp). */
  photoExtension: string;
  deductedFromWages?: boolean;
  supervisorApprovalId?: string | null;
}
export interface BreakageReportResponse {
  breakageId: string;
  stockMovementId: string;
  photoRelativePath: string;
  totalLossPesewas: number;
}
export interface BreakageListRecentResponse {
  breakages: Array<{
    id: string; productName: string; productSku: string; quantity: number;
    cause: string; workerName: string; createdAt: string;
    photoRelativePath: string; totalLossPesewas: number;
  }>;
}

// --- consumption -----------------------------------------------------------

export interface ConsumptionGetUsageRequest { workerId?: string }
export interface ConsumptionGetUsageResponse {
  workerId: string; monthIso: string; unitsAllowed: number; unitsUsed: number; unitsRemaining: number;
}
export interface ConsumptionLogRequest {
  productId: string;
  quantity: number;
  supervisorApprovalId?: string | null;
}
export interface ConsumptionLogResponse {
  rowsInserted: number;
  unitsFree: number;
  unitsPaid: number;
  costToWorkerPesewas: number;
}

// --- stock receipts --------------------------------------------------------

export interface StockReceiveRequest {
  supplierId: string | null;
  /** When true, supplierId may be null and the receipt is recorded as OPENING_STOCK. */
  isOpeningStock?: boolean;
  supervisorWorkerId: string;
  supervisorPin: string;
  purchaseOrderId?: string | null;
  supplierInvoiceNumber?: string | null;
  supplierInvoiceDate?: string | null;
  supplierDueDate?: string | null;
  transportCostPesewas?: number;
  loadingCostPesewas?: number;
  lines: Array<{ productId: string; quantity: number; unitCostPesewas: number; unitId?: string | null }>;
  notes?: string | null;
  /** Confirm a receipt the backend refused with a COST_SWING error (implied
   *  per-canonical cost change over ±50% — usually a per-crate/per-bottle
   *  cost mix-up). */
  allowLargeCostSwing?: boolean;
}
export interface StockReceiveResponse {
  movementCount: number;
  supplierInvoiceId: string | null;
  totalValuePesewas: number;
  totalPayablePesewas: number;
  productsCostUpdated: number;
}

export interface SupplierListResponse {
  suppliers: Array<{
    id: string; name: string; contactPerson: string | null; phone: string | null;
    paymentTermsDays: number; currentBalancePesewas: number; reliabilityScore: number | null;
  }>;
}

// --- worker admin ----------------------------------------------------------

export interface WorkerAdminListResponse {
  workers: Array<{
    id: string; fullName: string; phone: string; role: string; active: boolean;
    hiredAt: string; terminatedAt: string | null; terminationReason: string | null;
    consumptionAllowanceUnits: number; baseSalaryPesewas: number;
  }>;
}
export interface WorkerAddRequest {
  fullName: string;
  phone: string;
  role: 'OWNER' | 'FOUNDER' | 'SUPERVISOR' | 'COUNTER' | 'DRIVER' | 'STOCKMASTER';
  pin: string;
  baseSalaryPesewas?: number;
  consumptionAllowanceUnits?: number;
  hiredAt?: string;
  notes?: string | null;
}
export interface WorkerAddResponse { workerId: string }
export interface WorkerDeactivateRequest { workerId: string }
export interface WorkerReactivateRequest { workerId: string }
export interface WorkerTerminateRequest { workerId: string; reason: string }
export interface WorkerSimpleResponse { ok: true }
export interface WorkerChangePinRequest { oldPin: string; newPin: string }
export interface WorkerResetPinRequest { workerId: string; newPin: string }

// --- stocktake (Session 5) -------------------------------------------------

export const IPC_CHANNELS_S5 = {
  STOCKTAKE_START: 'stocktake:start',
  STOCKTAKE_GET_ACTIVE: 'stocktake:get-active',
  STOCKTAKE_RECORD_LINE: 'stocktake:record-line',
  STOCKTAKE_COMPLETE: 'stocktake:complete',
  STOCKTAKE_CANCEL: 'stocktake:cancel',
  STOCKTAKE_LIST_RECENT: 'stocktake:list-recent',
  STOCKTAKE_GET_WITH_LINES: 'stocktake:get-with-lines',
  CASH_DROP_RECORD: 'cash-drop:record',
  CASH_DROP_LIST: 'cash-drop:list',
  CASH_DROP_GET_EXPECTED: 'cash-drop:get-expected',
  DRAWING_POLICY_LIST: 'drawing-policy:list',
  DRAWING_POLICY_UPSERT: 'drawing-policy:upsert',
  DRAWING_REPORT: 'drawing:report',
  DAILY_SUMMARY_GENERATE: 'daily-summary:generate',
  DAILY_SUMMARY_GET: 'daily-summary:get',
  DAILY_SUMMARY_LIST: 'daily-summary:list',
} as const;

export interface StocktakeStartRequest {
  /** Optional cycle-counting filter — A/B/C class only or null/undefined for everything. */
  countClass?: 'A' | 'B' | 'C' | null;
}
export interface StocktakeStartResponse { eventId: string; productCount: number }
export interface StocktakeGetActiveResponse {
  active: { id: string; status: string; startedAt: string; productsCounted: number;
            productsWithVariance: number; totalLossValuePesewas: number;
            totalFoundValuePesewas: number; totalExpectedStockValuePesewas: number;
            shrinkageRate: number | null; notes: string | null } | null;
}
export interface StocktakeRecordLineRequest { eventId: string; productId: string; countedQty: number; unitId?: string | null }
export interface StocktakeRecordLineResponse { variance: number; varianceValuePesewas: number; canonicalCount: number }
export interface StocktakeCompleteRequest {
  eventId: string; supervisorWorkerId: string; supervisorPin: string; notes?: string | null;
}
export interface StocktakeCompleteResponse {
  eventId: string; movementsEmitted: number; totalLossValuePesewas: number;
  totalFoundValuePesewas: number; shrinkageRate: number | null;
  productsCounted: number; productsWithVariance: number;
}
export interface StocktakeCancelRequest { eventId: string }
export interface StocktakeCancelResponse { ok: true }
export interface StocktakeListRecentResponse {
  events: Array<{ id: string; status: string; startedAt: string; completedAt: string | null;
    productsCounted: number; productsWithVariance: number;
    totalLossValuePesewas: number; totalFoundValuePesewas: number;
    totalExpectedStockValuePesewas: number; shrinkageRate: number | null;
    notes: string | null }>;
}
export interface StocktakeGetWithLinesRequest { eventId: string }
export interface StocktakeGetWithLinesResponse {
  event: StocktakeGetActiveResponse['active'];
  lines: Array<{ id: string; productId: string; productName: string; productSku: string;
    expectedQty: number; countedQty: number | null; variance: number | null;
    unitCostPesewas: number; varianceValuePesewas: number | null }>;
}

export interface CashDropRecordRequest {
  shiftId: string; amountPesewas: number; recipient: string; notes?: string | null;
  category?: 'GENERIC_DROP' | 'OWNER_DRAWING' | 'FAMILY_SUPPORT' | 'OWNER_SALARY' | 'OTHER_DRAWING';
  drawingPolicyId?: string | null;
  supervisorWorkerId: string; supervisorPin: string;
}
export interface CashDropRecordResponse { cashCountId: string; expectedCashAfterDropPesewas: number }
export interface CashDropListRequest { shiftId: string }
export interface CashDropListResponse {
  drops: Array<{ id: string; amountPesewas: number; notes: string | null;
    category: 'GENERIC_DROP' | 'OWNER_DRAWING' | 'FAMILY_SUPPORT' | 'OWNER_SALARY' | 'OTHER_DRAWING';
    beneficiaryName: string | null;
    supervisorId: string | null; createdAt: string; workerName: string;
    supervisorName: string | null }>;
}
export interface CashDropGetExpectedRequest { shiftId: string }
export interface CashDropGetExpectedResponse { expectedCashPesewas: number }

export type DrawingCategory = 'OWNER_DRAWING' | 'FAMILY_SUPPORT' | 'OWNER_SALARY' | 'OTHER_DRAWING';
export type DrawingCadence = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'AD_HOC';
export interface DrawingPolicyRow {
  id: string; category: DrawingCategory; beneficiaryName: string;
  cadence: DrawingCadence; limitPesewas: number; active: boolean; notes: string | null;
}
export interface DrawingPolicyListResponse { policies: DrawingPolicyRow[] }
export interface DrawingPolicyUpsertRequest {
  id?: string | null; category: DrawingCategory; beneficiaryName: string;
  cadence: DrawingCadence; limitPesewas: number; active?: boolean; notes?: string | null;
}
export interface DrawingPolicyUpsertResponse { policyId: string }
export interface DrawingReportRequest {
  period: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  fromDate: string; toDate: string; locationId?: string | null;
  reportAccessToken: string;
}
export interface DrawingReportResponse {
  rows: Array<{ periodKey: string; category: DrawingCategory; beneficiaryName: string; totalPesewas: number; count: number }>;
}

export interface DailySummaryGenerateRequest { date: string; locationId?: string }
// Mirrors the DailySummary shape returned by dailySummaries.ts. The list
// endpoint deliberately returns a narrower shape with `date` instead of
// `summaryDate` — keep them separate; do not merge.
export interface DailySummaryGenerateResponse {
  id: string;
  summaryDate: string; locationId: string;
  totalRevenuePesewas: number; totalCostOfGoodsSoldPesewas: number;
  grossMarginPesewas: number; totalBreakageValuePesewas: number;
  totalConsumptionValuePesewas: number;
  totalExpensesValuePesewas: number;
  expensesByCategory: Array<{ category: string; totalPesewas: number; count: number }>;
  cashCountVariancePesewas: number;
  stocktakeShrinkageValuePesewas: number | null; stocktakeShrinkageRate: number | null;
  creditExtendedPesewas: number; creditCollectedPesewas: number;
  totalOutstandingCreditPesewas: number;
  numSales: number; numUniqueCustomers: number;
  topSkus: Array<{ sku: string; name: string; revenuePesewas: number; unitsSold: number }>;
  reorderAlerts: Array<{ sku: string; name: string; unitsOnHand: number; reorderThreshold: number }>;
  shiftSummaries: Array<{ shiftId: string; workerName: string;
    totalSalesPesewas: number; cashVariancePesewas: number | null; closedAt: string | null }>;
  generatedAt: string;
  whatsappSentAt: string | null;
}
export interface DailySummaryGetRequest { date: string; locationId?: string }
export type DailySummaryGetResponse = DailySummaryGenerateResponse | null;
export interface DailySummaryListRequest { limit?: number }
export interface DailySummaryListResponse {
  summaries: Array<{ date: string; locationId: string; revenuePesewas: number;
    numSales: number; shrinkageRate: number | null;
    generatedAt: string; whatsappSentAt: string | null }>;
}

// --- Session 6: products + customers admin --------------------------------

export const IPC_CHANNELS_S6 = {
  PRODUCT_ADMIN_LIST: 'product:admin-list',
  PRODUCT_ADD: 'product:add',
  PRODUCT_UPDATE: 'product:update',
  PRODUCT_DEACTIVATE: 'product:deactivate',
  PRODUCT_REACTIVATE: 'product:reactivate',
  CUSTOMER_CREATE: 'customer:create',
  CUSTOMER_UPDATE: 'customer:update',
  CUSTOMER_BLOCK: 'customer:block',
  CUSTOMER_UNBLOCK: 'customer:unblock',
} as const;

export interface ProductAdminListResponse {
  products: Array<{
    id: string; sku: string; barcode: string | null; name: string;
    category: string; brand: string | null;
    packSizeUnits: number; unitVolumeMl: number | null;
    isReturnable: boolean; bottleDepositPesewas: number;
    costPricePesewas: number; walkInPricePesewas: number;
    wholesalePricePesewas: number; routePricePesewas: number;
    minimumPricePesewas: number;
    competitorPricePesewas: number | null;
    competitorName: string | null;
    competitorCheckedAt: string | null;
    reorderThreshold: number; reorderQuantity: number;
    primarySupplierId: string | null;
    defaultLeadTimeDays: number; shelfLifeDays: number | null;
    countClass: 'A' | 'B' | 'C' | null;
    primaryPurchaseUnitId: string | null;
    primarySaleUnitId: string | null;
    active: boolean; unitsOnHand: number;
    units: Array<{ id: string; unitName: string; conversionFactor: number }>;
  }>;
}

export interface ProductAddRequest {
  sku: string; barcode?: string | null; name: string; category: string;
  brand?: string | null; packSizeUnits?: number; unitVolumeMl?: number | null;
  isReturnable?: boolean; bottleDepositPesewas?: number;
  costPricePesewas: number; walkInPricePesewas: number;
  wholesalePricePesewas: number; routePricePesewas: number;
  minimumPricePesewas?: number;
  competitorPricePesewas?: number | null;
  competitorName?: string | null;
  competitorCheckedAt?: string | null;
  reorderThreshold?: number; reorderQuantity?: number;
  primarySupplierId?: string | null;
  defaultLeadTimeDays?: number; shelfLifeDays?: number | null;
  countClass?: 'A' | 'B' | 'C' | null;
  /**
   * Optional sellable/purchasable units (CRATE, PACK, BAG_50KG, etc).
   * Created in the same transaction as the product.
   */
  units?: Array<{
    unitName: string;
    conversionFactor: number;
    pricePesewas: number;
    isSaleUnit?: boolean;
    isPurchaseUnit?: boolean;
    notes?: string | null;
  }>;
}
export interface ProductAddResponse {
  productId: string;
  warnings: string[];
  unitIds: string[];
}

export interface ProductUpdateRequest {
  productId: string;
  fields: Partial<{
    name: string; category: string; brand: string | null;
    packSizeUnits: number; unitVolumeMl: number | null;
    isReturnable: boolean; bottleDepositPesewas: number;
    costPricePesewas: number; walkInPricePesewas: number;
    wholesalePricePesewas: number; routePricePesewas: number;
    minimumPricePesewas: number;
    competitorPricePesewas: number | null;
    competitorName: string | null;
    competitorCheckedAt: string | null;
    priceChangeReason: string | null;
    reorderThreshold: number; reorderQuantity: number;
    primarySupplierId: string | null;
    defaultLeadTimeDays: number; shelfLifeDays: number | null;
    barcode: string | null;
    countClass: 'A' | 'B' | 'C' | null;
    primaryPurchaseUnitId: string | null;
    primarySaleUnitId: string | null;
  }>;
}
export interface ProductUpdateResponse { warnings: string[] }
export interface ProductSimpleRequest { productId: string }
export interface ProductSimpleResponse { ok: true }

export interface CustomerCreateRequest {
  displayName: string; phone: string;
  customerType?: 'WALK_IN_REGULAR' | 'WHOLESALE' | 'ROUTE' | 'STAFF_FAMILY';
  alternatePhone?: string | null;
  businessName?: string | null;
  locationDescription?: string | null;
  creditLimitPesewas?: number;
  creditTermsDays?: number;
  cashOnly?: boolean;
  preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  notes?: string | null;
}
export interface CustomerCreateResponse { customerId: string; alreadyExisted: boolean }

export interface CustomerUpdateRequest {
  customerId: string;
  fields: Partial<{
    displayName: string;
    alternatePhone: string | null;
    customerType: 'WALK_IN_REGULAR' | 'WHOLESALE' | 'ROUTE' | 'STAFF_FAMILY';
    businessName: string | null;
    locationDescription: string | null;
    creditLimitPesewas: number;
    creditTermsDays: number;
    cashOnly: boolean;
    preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
    notes: string | null;
  }>;
}
export interface CustomerSimpleResponse { ok: true }

export interface CustomerBlockRequest { customerId: string; reason: string }
export interface CustomerUnblockRequest { customerId: string }

// --- Session 7: pricing tiers + discount supervisor + sale relookup -------

export const IPC_CHANNELS_S7 = {
  PRICING_TIER_LIST_FOR_PRODUCT: 'pricing:list-for-product',
  PRICING_TIER_ADD: 'pricing:add',
  PRICING_TIER_UPDATE: 'pricing:update',
  PRICING_TIER_DEACTIVATE: 'pricing:deactivate',
  PRICING_TIER_REACTIVATE: 'pricing:reactivate',
  PRICING_TIER_GET_BEST: 'pricing:get-best',
  SALE_GET_LINES: 'sale:get-lines',
} as const;

export type PricingChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | 'ALL';

export interface PricingTierRow {
  id: string; productId: string; channel: PricingChannel;
  minQuantity: number; unitPricePesewas: number;
  priority: number; active: boolean; notes: string | null;
  appliesToUnitId: string | null;
}

export interface PricingTierListForProductRequest { productId: string }
export interface PricingTierListForProductResponse { tiers: PricingTierRow[] }

export interface PricingTierAddRequest {
  productId: string;
  channel: PricingChannel;
  minQuantity: number;
  unitPricePesewas: number;
  priority?: number;
  notes?: string | null;
  appliesToUnitId?: string | null;
}
export interface PricingTierAddResponse { tierId: string }

export interface PricingTierUpdateRequest {
  tierId: string;
  fields: Partial<{ unitPricePesewas: number; priority: number; notes: string | null }>;
}
export interface PricingTierSimpleResponse { ok: true }
export interface PricingTierIdRequest { tierId: string }

export interface PricingTierGetBestRequest {
  productId: string; channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE'; quantity: number;
  unitId?: string | null;
}
export type PricingTierGetBestResponse = { tier: PricingTierRow | null };

export interface SaleGetLinesRequest { saleId: string }
export interface SaleGetLinesResponse {
  saleId: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
  customerId: string | null;
  customerName: string | null;
  lines: Array<{
    productId: string; productSku: string; productName: string;
    quantity: number; unitPricePesewas: number; unitsOnHand: number;
    // Unit info needed when re-loading into the cart on duplicate. unitId is
    // null for legacy pre-0015 sales; the renderer should treat those as the
    // synthetic UNIT (factor 1).
    unitId: string | null;
    unitName: string;
    factor: number;
  }>;
}

// Extend SaleCompleteRequest with optional supervisor fields.
// (Existing SaleCompleteRequest in shared types already has discount fields.)
export interface SaleCompleteSupervisor {
  supervisorWorkerId?: string | null;
  supervisorPin?: string | null;
}

// --- Session 8: customer credit + debt tracking ---------------------------

export const IPC_CHANNELS_S8 = {
  CUSTOMER_OVERVIEW: 'customer:overview',
  CUSTOMER_OPEN_SALES: 'customer:open-sales',
  CUSTOMER_RECORD_PAYMENT: 'customer:record-payment',
  CUSTOMER_LIST_BY_OUTSTANDING: 'customer:list-by-outstanding',
  CUSTOMER_AGING_SUMMARY: 'customer:aging-summary',
  CUSTOMER_RECONCILE: 'customer:reconcile',
  DEBT_COLLECTION_GET: 'debt-collection:get',
  DEBT_COLLECTION_QUEUE: 'debt-collection:queue',
  DEBT_FOLLOWUP_RECORD: 'debt-collection:followup-record',
  DEBT_STATUS_SET: 'debt-collection:status-set',
  PAYMENT_PROMISE_UPDATE: 'debt-collection:promise-update',
} as const;

export type DebtStatus = 'CURRENT' | 'OVERDUE' | 'PROMISED' | 'RECOVERABLE' | 'DOUBTFUL' | 'DEAD';
export type DebtContactMethod = 'CALL' | 'WHATSAPP' | 'VISIT' | 'IN_PERSON' | 'SMS' | 'OTHER';
export type DebtFollowupOutcome =
  | 'NO_ANSWER' | 'PROMISED_TO_PAY' | 'PART_PAID' | 'DISPUTED'
  | 'REFUSED' | 'REMINDER_SENT' | 'OTHER';
export type PaymentPromiseStatus = 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';

export interface CustomerOverviewRequest { customerId: string }
export interface CustomerOverviewResponse {
  id: string; displayName: string; phone: string; customerType: string;
  cashOnly: boolean;
  creditLimitPesewas: number;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  cachedBalancePesewas: number; trueBalancePesewas: number; driftPesewas: number;
  blocked: boolean; blockedReason: string | null;
  utilizationBps: number;
  ageOfOldestUnpaidDays: number | null;
  agingBuckets: { bucket0_30: number; bucket31_60: number; bucket61_90: number; bucket90_plus: number };
  recentSales: Array<{ id: string; createdAt: string; totalPesewas: number; creditPesewas: number; amountOutstandingPesewas: number; voided: boolean }>;
  recentPayments: Array<{ id: string; receivedAt: string; amountPesewas: number; paymentMethod: string; paymentReference: string | null }>;
}

export interface CustomerOpenSalesRequest { customerId: string }
export interface CustomerOpenSalesResponse {
  sales: Array<{
    saleId: string; createdAt: string; totalPesewas: number; creditPesewas: number;
    paidPesewas: number; outstandingPesewas: number; ageDays: number;
    dueDate: string | null; daysOverdue: number | null;
    debtStatus: DebtStatus;
  }>;
}

export interface CustomerRecordPaymentRequest {
  customerId: string;
  amountPesewas: number;
  paymentMethod: string;
  paymentReference?: string | null;
  allocations?: Array<{ saleId: string; amountPesewas: number }>;
  notes?: string | null;
  shiftId?: string | null;
}
export interface CustomerRecordPaymentResponse {
  paymentId: string;
  totalAllocatedPesewas: number;
  unallocatedPesewas: number;
  allocations: Array<{ saleId: string; amountPesewas: number }>;
  newBalancePesewas: number;
}

export interface CustomerListByOutstandingRequest {
  agingBucket?: 'bucket0_30' | 'bucket31_60' | 'bucket61_90' | 'bucket90_plus';
  includeBlocked?: boolean;
  includeZeroBalance?: boolean;
  limit?: number;
}
export interface CustomerListByOutstandingResponse {
  customers: Array<{
    id: string; displayName: string; phone: string; customerType: string;
    creditLimitPesewas: number; trueBalancePesewas: number; blocked: boolean;
    ageOfOldestUnpaidDays: number | null;
    oldestUnpaidBucket: 'bucket0_30' | 'bucket31_60' | 'bucket61_90' | 'bucket90_plus' | null;
    needsReconcile: boolean;
  }>;
}

export interface CustomerAgingSummaryResponse {
  bucket0_30: number; bucket31_60: number; bucket61_90: number; bucket90_plus: number;
  total: number; blockedCount: number; needsReviewCount: number;
}

export interface CustomerReconcileRequest { customerId: string }
export interface CustomerReconcileResponse {
  previousCached: number; newCached: number; driftPesewas: number;
}

export interface DebtCollectionSale {
  saleId: string;
  customerId: string;
  customerName: string;
  phone: string;
  createdAt: string;
  totalPesewas: number;
  creditPesewas: number;
  paidPesewas: number;
  outstandingPesewas: number;
  dueDate: string | null;
  daysOverdue: number | null;
  debtStatus: DebtStatus;
  cashOnly: boolean;
  creditLimitPesewas: number;
  lastFollowUpAt: string | null;
  nextFollowUpAt: string | null;
  openPromise: {
    id: string;
    promisedAmountPesewas: number;
    promiseDueDate: string;
    status: PaymentPromiseStatus;
    notes: string | null;
  } | null;
}

export interface DebtFollowupRow {
  id: string;
  customerId: string;
  saleId: string | null;
  contactMethod: DebtContactMethod;
  outcome: DebtFollowupOutcome;
  notes: string | null;
  nextFollowUpAt: string | null;
  createdAt: string;
  workerName: string;
}

export interface PaymentPromiseRow {
  id: string;
  customerId: string;
  saleId: string | null;
  promisedAmountPesewas: number;
  promiseDueDate: string;
  status: PaymentPromiseStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DebtCollectionGetRequest { customerId: string }
export interface DebtCollectionGetResponse {
  customerId: string;
  customerName: string;
  phone: string;
  cashOnly: boolean;
  blocked: boolean;
  blockedReason: string | null;
  creditLimitPesewas: number;
  totalOutstandingPesewas: number;
  oldestOverdueDays: number | null;
  openSales: DebtCollectionSale[];
  recentFollowUps: DebtFollowupRow[];
  promises: PaymentPromiseRow[];
}

export interface DebtCollectionQueueRequest { includeCurrent?: boolean; limit?: number }
export interface DebtCollectionQueueResponse { rows: DebtCollectionSale[] }

export interface DebtFollowupRecordRequest {
  customerId: string;
  saleId?: string | null;
  contactMethod: DebtContactMethod;
  outcome: DebtFollowupOutcome;
  notes?: string | null;
  nextFollowUpAt?: string | null;
  promisedAmountPesewas?: number | null;
  promiseDueDate?: string | null;
}
export interface DebtFollowupRecordResponse { followupId: string; promiseId: string | null }

export interface DebtStatusSetRequest { saleId: string; status: DebtStatus }
export interface DebtSimpleResponse { ok: true }

export interface PaymentPromiseUpdateRequest {
  promiseId: string;
  status: PaymentPromiseStatus;
  fulfilledPaymentId?: string | null;
}

// --- Session 9b: product units UI surface ---------------------------------

export const IPC_CHANNELS_S9 = {
  PRODUCT_UNIT_LIST_FOR_PRODUCT: 'product-unit:list-for-product',
  PRODUCT_UNIT_ADD: 'product-unit:add',
  PRODUCT_UNIT_UPDATE: 'product-unit:update',
  PRODUCT_UNIT_DEACTIVATE: 'product-unit:deactivate',
  PRODUCT_UNIT_REACTIVATE: 'product-unit:reactivate',
} as const;

export interface ProductUnitRow {
  id: string;
  productId: string;
  unitName: string;
  conversionFactor: number;
  pricePesewas: number;
  isPurchaseUnit: boolean;
  isSaleUnit: boolean;
  displayOrder: number;
  active: boolean;
  notes: string | null;
}

export interface ProductUnitListRequest { productId: string; activeOnly?: boolean }
export interface ProductUnitListResponse { units: ProductUnitRow[] }

export interface ProductUnitAddRequest {
  productId: string;
  unitName: string;
  conversionFactor: number;
  pricePesewas: number;
  isPurchaseUnit?: boolean;
  isSaleUnit?: boolean;
  displayOrder?: number;
  notes?: string | null;
}
export interface ProductUnitAddResponse { unitId: string }

export interface ProductUnitUpdateRequest {
  unitId: string;
  fields: Partial<{
    unitName: string;
    conversionFactor: number;
    pricePesewas: number;
    isPurchaseUnit: boolean;
    isSaleUnit: boolean;
    displayOrder: number;
    notes: string | null;
  }>;
}
export interface ProductUnitSimpleResponse { ok: true }
export interface ProductUnitIdRequest { unitId: string }

// --- Session 11: first-run setup ------------------------------------------

export const IPC_CHANNELS_S11 = {
  SETUP_NEEDS_OWNER: 'setup:needs-owner',
  SETUP_CREATE_OWNER: 'setup:create-owner',
} as const;

export interface SetupNeedsOwnerResponse { needsOwner: boolean }

export interface SetupCreateOwnerRequest {
  fullName: string;
  phone: string;
  pin: string;
}
export interface SetupCreateOwnerResponse {
  workerId: string;
  fullName: string;
  role: 'OWNER';
  /** One-time plaintext recovery code generated at setup. Show ONCE; the
   *  hash is stored. The user is supposed to write it down. */
  recoveryCode: string;
}

// --- Session 11: suppliers admin ------------------------------------------

export const IPC_CHANNELS_S11_SUP = {
  SUPPLIER_ADMIN_LIST: 'supplier:admin-list',
  SUPPLIER_ADD: 'supplier:add',
  SUPPLIER_UPDATE: 'supplier:update',
  SUPPLIER_DEACTIVATE: 'supplier:deactivate',
  SUPPLIER_REACTIVATE: 'supplier:reactivate',
} as const;

export interface AdminSupplier {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  paymentTermsDays: number;
  creditLimitPesewas: number;
  paymentSchedule: 'ON_RECEIPT' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
  currentBalancePesewas: number;
  notes: string | null;
  active: boolean;
}
export interface SupplierAdminListResponse { suppliers: AdminSupplier[] }

export interface SupplierAddRequest {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  paymentTermsDays?: number;
  creditLimitPesewas?: number;
  paymentSchedule?: 'ON_RECEIPT' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
  notes?: string | null;
}
export interface SupplierAddResponse { supplierId: string }

export interface SupplierUpdateRequest {
  supplierId: string;
  fields: Partial<{
    name: string;
    contactPerson: string | null;
    phone: string | null;
    email: string | null;
    paymentTermsDays: number;
    creditLimitPesewas: number;
    paymentSchedule: 'ON_RECEIPT' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
    notes: string | null;
  }>;
}
export interface SupplierIdRequest { supplierId: string }
export interface SupplierSimpleResponse { ok: true }

// --- Session 12: audit log viewer -----------------------------------------

export const IPC_CHANNELS_S12_AUDIT = {
  AUDIT_LIST: 'audit:list',
  AUDIT_LIST_ACTIONS: 'audit:list-actions',
  AUDIT_LIST_ENTITY_TYPES: 'audit:list-entity-types',
} as const;

export interface AuditEntry {
  id: string;
  workerId: string;
  workerName: string;
  workerRole: string;
  action: string;
  entityType: string;
  entityId: string;
  /** Display name for entity_id (customer/worker/product/supplier). Null
   *  for entity types we don't resolve (sales, shifts, stock_movements). */
  entityName: string | null;
  beforeValue: unknown | null;
  afterValue: unknown | null;
  deviceId: string;
  notes: string | null;
  createdAt: string;
}

export interface AuditListRequest {
  workerId?: string | null;
  action?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}
export interface AuditListResponse {
  entries: AuditEntry[];
  totalCount: number;
  /** ID → display name for every customer/worker/product/supplier referenced
   *  in entries[] (entityId AND IDs embedded in JSON values). Renderer uses
   *  this to swap IDs for names when pretty-printing the before/after JSON. */
  idNames: Record<string, string>;
}
export interface AuditListActionsResponse { actions: string[] }
export interface AuditListEntityTypesResponse { entityTypes: string[] }

// --- Session 12: breakage photo review -----------------------------------

export const IPC_CHANNELS_S12_BREAK = {
  BREAKAGE_REVIEW_LIST: 'breakage:review-list',
  BREAKAGE_REVIEW_CAUSES: 'breakage:review-causes',
  BREAKAGE_PHOTO_DATA: 'breakage:photo-data',
} as const;

export interface BreakageReviewRow {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  quantity: number;
  cause: string;
  causeDescription: string | null;
  workerId: string;
  workerName: string;
  workerRole: string;
  photoRelativePath: string;
  totalLossPesewas: number;
  deductedFromWages: boolean;
  supervisorApprovalId: string | null;
  createdAt: string;
}
export interface BreakageReviewListRequest {
  workerId?: string | null;
  cause?: string | null;
  productId?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
  offset?: number;
}
export interface BreakageReviewListResponse {
  rows: BreakageReviewRow[];
  totalCount: number;
  totalLossPesewas: number;
}
export interface BreakageReviewCausesResponse { causes: string[] }
export interface BreakagePhotoRequest { relativePath: string }
export interface BreakagePhotoResponse {
  found: boolean;
  dataUri?: string;
  bytes?: number;
}

// --- Session 12: pending receipt reprints --------------------------------

export const IPC_CHANNELS_S12_REPRINT = {
  REPRINT_LIST: 'reprint:list',
  REPRINT_RETRY: 'reprint:retry',
  REPRINT_DISCARD: 'reprint:discard',
  REPRINT_PENDING_COUNT: 'reprint:pending-count',
} as const;

export interface PendingReprint {
  id: string;
  saleId: string;
  reason: string;
  saleTotalPesewas: number;
  saleCreatedAt: string;
  saleWorkerName: string;
  ageHours: number;
  createdAt: string;
}
export interface ReprintListResponse { reprints: PendingReprint[] }
export interface ReprintRetryRequest { reprintId: string }
export interface ReprintRetryResponse {
  ok: boolean;
  printed: boolean;
  error?: string;
}
export interface ReprintDiscardRequest { reprintId: string; reason: string }
export interface ReprintSimpleResponse { ok: true }
export interface ReprintPendingCountResponse { count: number }

// --- Session 12: stock movement history -----------------------------------

export const IPC_CHANNELS_S12_STOCK = {
  STOCK_HISTORY_FOR_PRODUCT: 'stock:history-for-product',
} as const;

export interface StockHistoryRow {
  movementId: string;
  createdAt: string;
  signedQuantity: number;
  reasonCode: string;
  reasonCategory: 'inflow' | 'outflow' | 'neutral';
  workerId: string;
  workerName: string;
  workerRole: string;
  supervisorApprovalId: string | null;
  supervisorName: string | null;
  unitCostPesewas: number;
  totalValuePesewas: number;
  notes: string | null;
  saleId: string | null;
  breakageLogId: string | null;
  runningBalance: number;
}
export interface StockHistoryRequest { productId: string; limit?: number }
export interface StockHistoryResponse {
  rows: StockHistoryRow[];
  currentOnHand: number;
}

// --- Session 14: on-demand receipt reprint --------------------------------

export const IPC_CHANNELS_S14_REPRINT = {
  SALE_REPRINT_RECEIPT: 'sale:reprint-receipt',
  SALE_GET_RECEIPT: 'sale:get-receipt',
} as const;

export interface SaleReprintRequest { saleId: string }
export interface SaleReprintResponse {
  ok: boolean;
  printed: boolean;
  error?: string;
}

export interface SaleGetReceiptRequest { saleId: string }
export interface SaleGetReceiptResponse {
  receipt: import('../lib/receipt.js').SaleReceipt;
  voidRequest: {
    status: SaleVoidRequestStatus;
    reason: string;
    requesterName: string;
    requestedAt: string;
    reviewerName: string | null;
    reviewedAt: string | null;
    reviewNote: string | null;
  } | null;
  /**
   * Outstanding balance on this sale (pesewas), 0 for fully-paid credit
   * sales. NULL for non-credit (cash/MoMo) sales — there's no "outstanding"
   * concept for them and the UI hides the credit-status block.
   */
  amountOutstandingPesewas: number | null;
  /** Sum of payments against this sale (tenders at sale time + later allocations). */
  amountPaidPesewas: number;
}

// --- Session 15: period close (day lock) ---------------------------------

export const IPC_CHANNELS_S15_PERIOD = {
  PERIOD_GET_ACTIVE_CLOSE: 'period:get-active-close',
  PERIOD_LIST_CLOSES: 'period:list-closes',
  PERIOD_SEAL: 'period:seal',
  PERIOD_REOPEN: 'period:reopen',
} as const;

export interface PeriodCloseRow {
  id: string;
  locationId: string;
  businessDate: string;
  sealedAt: string;
  sealedBy: string;
  sealedByName: string;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenedByName: string | null;
  reopenedReason: string | null;
}
export interface PeriodGetActiveCloseRequest { businessDate: string }
export interface PeriodGetActiveCloseResponse { close: PeriodCloseRow | null }
export interface PeriodListClosesResponse { closes: PeriodCloseRow[] }
export interface PeriodSealRequest { businessDate: string }
export interface PeriodSealResponse { closeId: string }
export interface PeriodReopenRequest { businessDate: string; reason: string }
export interface PeriodReopenResponse { closeId: string }

// --- Session 15: exception reports ---------------------------------------

export const IPC_CHANNELS_S15_EXC = {
  EXC_VOIDS_BY_CASHIER: 'exc:voids-by-cashier',
  EXC_DISCOUNTS_BY_CASHIER: 'exc:discounts-by-cashier',
  EXC_POST_SALE_EDITS: 'exc:post-sale-edits',
  EXC_REPEATED_SKU_VOIDS: 'exc:repeated-sku-voids',
  EXC_LARGE_DISCOUNTS: 'exc:large-discounts',
  EXC_UNDERPRICED_LINES: 'exc:underpriced-lines',
  EXC_NEGATIVE_STOCK: 'exc:negative-stock',
} as const;

export interface ExcDateRangeRequest { fromDate: string; toDate: string }

export interface CashierVoidRow {
  workerId: string; workerName: string; workerRole: string;
  voidCount: number; voidValuePesewas: number;
}
export interface CashierDiscountRow {
  workerId: string; workerName: string; workerRole: string;
  discountSaleCount: number; totalDiscountPesewas: number; largestDiscountPesewas: number;
}
export interface PostSaleEditRow {
  saleId: string; saleCreatedAt: string; saleWorkerName: string;
  editAuditId: string; editAt: string; editAction: string;
  editWorkerName: string; editWorkerRole: string;
}
export interface RepeatedSkuVoidRow {
  businessDate: string; workerId: string; workerName: string;
  productId: string; productName: string; voidCount: number;
}
export interface LargeDiscountRow {
  saleId: string; saleAt: string; workerName: string;
  totalPesewas: number; discountPesewas: number; discountRatio: number; reason: string | null;
}
export interface UnderpricedLineRow {
  saleId: string; saleAt: string; workerName: string;
  sku: string; productName: string; unitName: string;
  quantity: number; unitPricePesewas: number; listPricePesewas: number;
  shortfallPesewas: number;
}
export interface NegativeStockRow {
  productId: string; sku: string; productName: string;
  unitsOnHand: number; valueAtCostPesewas: number;
}
export interface ExcVoidsByCashierResponse { rows: CashierVoidRow[] }
export interface ExcDiscountsByCashierResponse { rows: CashierDiscountRow[] }
export interface ExcPostSaleEditsResponse { rows: PostSaleEditRow[] }
export interface ExcRepeatedSkuVoidsResponse { rows: RepeatedSkuVoidRow[] }
export interface ExcLargeDiscountsResponse { rows: LargeDiscountRow[] }
export interface ExcUnderpricedLinesResponse { rows: UnderpricedLineRow[] }
export interface ExcNegativeStockRequest { locationId?: string }
export interface ExcNegativeStockResponse { rows: NegativeStockRow[] }

// --- Session 16: reorder PO suggestions ----------------------------------

export const IPC_CHANNELS_S16_REORDER = {
  REORDER_SUGGEST: 'reorder:suggest',
  REORDER_CREATE_DRAFT_PO: 'reorder:create-draft-po',
  REORDER_LIST_DRAFTS: 'reorder:list-drafts',
} as const;

export interface ReorderSuggestion {
  productId: string; sku: string; productName: string;
  primarySupplierId: string | null; primarySupplierName: string | null;
  currentOnHand: number; reorderThreshold: number;
  suggestedQty: number; lastCostPesewas: number; suggestedLineValuePesewas: number;
}
export interface ReorderSuggestRequest {
  supplierId?: string | null;       // null = unassigned, undefined = all
  safetyMultiplier?: number;
}
export interface ReorderSuggestResponse { suggestions: ReorderSuggestion[] }

export interface ReorderCreateDraftPORequest {
  supplierId: string;
  lines: Array<{ productId: string; quantity: number; unitCostPesewas: number }>;
  notes?: string | null;
  expectedDeliveryDate?: string | null;
}
export interface ReorderCreateDraftPOResponse {
  poId: string; poNumber: string; totalOrderedPesewas: number;
}

export interface DraftPOSummary {
  id: string; poNumber: string; supplierId: string; supplierName: string;
  status: string; totalOrderedPesewas: number; lineCount: number; createdAt: string;
}
export interface ReorderListDraftsResponse { drafts: DraftPOSummary[] }

// --- Session 17: petty cash expenses -------------------------------------

export const IPC_CHANNELS_S17_EXPENSES = {
  EXPENSE_RECORD: 'expense:record',
  EXPENSE_LIST_FOR_SHIFT: 'expense:list-for-shift',
  EXPENSE_TOTALS_FOR_SHIFT: 'expense:totals-for-shift',
} as const;

export type ExpenseCategory =
  | 'RENT' | 'UTILITIES' | 'TRANSPORT' | 'SUPPLIES'
  | 'COMMS' | 'REPAIRS' | 'BANK_FEES'
  | 'STAFF_WAGES' | 'STAFF_ADVANCE' | 'COMMISSION' | 'STAFF_WELFARE'
  | 'OTHER';

export interface ExpenseRecordRequest {
  amountPesewas: number;
  category: ExpenseCategory;
  payee?: string | null;
  notes?: string | null;
  /** Required for amounts >= ₵100. */
  supervisorWorkerId?: string | null;
  supervisorPin?: string | null;
  /** Receipt photo bytes — required for amounts >= ₵50. Base64-encoded. */
  photoBase64?: string | null;
  photoExtension?: string | null;
}
export interface ExpenseRecordResponse { expenseId: string }

export interface ExpenseRow {
  id: string; amountPesewas: number; category: ExpenseCategory;
  payee: string | null; photoUrl: string | null; notes: string | null;
  workerId: string; workerName: string;
  supervisorApprovalId: string | null; supervisorName: string | null;
  createdAt: string;
}
export interface ExpenseListForShiftResponse { rows: ExpenseRow[] }
export interface ExpenseTotalsForShiftResponse {
  totalPesewas: number;
  byCategory: Array<{ category: ExpenseCategory; totalPesewas: number; count: number }>;
}

// --- Session 18: OWNER recovery code -------------------------------------

export const IPC_CHANNELS_S18_RECOVERY = {
  RECOVERY_LIST_OWNERS: 'recovery:list-owners',
  RECOVERY_RESET_PIN: 'recovery:reset-pin',
  RECOVERY_REGENERATE: 'recovery:regenerate',
} as const;

export interface RecoveryOwnerRow { id: string; fullName: string; hasCode: boolean }
export interface RecoveryListOwnersResponse { owners: RecoveryOwnerRow[] }

export interface RecoveryResetPinRequest {
  workerId: string;
  recoveryCode: string;
  newPin: string;
}
export interface RecoveryResetPinResponse {
  workerId: string;
  fullName: string;
  /** Fresh recovery code generated AFTER successful reset. Show ONCE. */
  newRecoveryCode: string;
}

export interface RecoveryRegenerateResponse {
  /** Fresh recovery code. Show ONCE. */
  newRecoveryCode: string;
}

// --- Wave B.2: Off-site backup heartbeat ---------------------------------

export const IPC_CHANNELS_BACKUP = {
  BACKUP_GET_HEARTBEAT: 'backup:get-heartbeat',
  BACKUP_GET_CONFIG: 'backup:get-config',
  BACKUP_SET_CONFIG: 'backup:set-config',
  BACKUP_RUN_NOW: 'backup:run-now',
  BACKUP_TEST_TARGET: 'backup:test-target',
  BACKUP_LIST_HISTORY: 'backup:list-history',
  BACKUP_REVEAL_TARGET: 'backup:reveal-target',
} as const;

export const IPC_CHANNELS_SYNC = {
  SYNC_GET_STATUS: 'sync:get-status',
  SYNC_GET_CONFIG: 'sync:get-config',
  SYNC_SET_CONFIG: 'sync:set-config',
  SYNC_ADD_SHOP: 'sync:add-shop',
} as const;

export interface SyncStatus {
  configured: boolean;
  role: 'HQ' | 'SHOP' | null;
  shopId: string | null;
  centralUrl: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
  pendingCount: number;
}
export interface SyncConfigView {
  shopId: string | null;
  centralUrl: string | null;
  role: 'HQ' | 'SHOP';
  hasToken: boolean;
}
export interface SyncSetConfigRequest {
  shopId: string;
  centralUrl: string;
  token?: string;
  role: 'HQ' | 'SHOP';
}
/** Self-service branch onboarding: add a sibling shop under THIS install's own
 *  company. Requires this install to already be provisioned (see SyncTab). */
export interface AddShopRequest {
  shopId: string;
}
export interface AddShopResult {
  shopId: string;
  role: 'SHOP';
  /** The new branch's bearer token — shown to the OWNER exactly once so they
   *  can copy it into that branch's own Settings -> Sync. Never stored here. */
  token: string;
  centralUrl: string;
}

export type BackupLocationClass = 'usb' | 'cloud' | 'local';

export interface BackupConfigResponse {
  targetDir: string;
  locationClass: BackupLocationClass;
  configured: boolean;
}

export interface BackupSetConfigRequest {
  targetDir: string;
  locationClass: BackupLocationClass;
}

export interface BackupRunNowResponse {
  ok: boolean;
  dbDest?: string;
  sizeBytes?: number;
  usedVacuum?: boolean;
  timestamp?: string;
  error?: string;
}

export interface BackupTestTargetRequest {
  /** Optional override; if omitted, tests the currently configured target. */
  targetDir?: string;
}

export interface BackupTestTargetResponse {
  ok: boolean;
  /** Resolved absolute path that was tested. */
  targetDir: string;
  /** Whether the directory existed (vs was created during the probe). */
  preexisted: boolean;
  /** Error message if the probe failed. */
  error?: string;
}

export interface BackupHistoryEntry {
  filename: string;
  fullPath: string;
  sizeBytes: number;
  /** ISO timestamp from mtime. */
  mtime: string;
  /** Milliseconds since mtime, as of when the list was generated. */
  ageMs: number;
}

export interface BackupListHistoryResponse {
  targetDir: string;
  entries: BackupHistoryEntry[];
  /** Set when entries is empty for a reason worth showing. */
  reason?: 'no-such-dir' | 'no-backups-yet' | 'unreadable';
  /** Free-text detail when reason='unreadable'. */
  errorDetail?: string;
}

export interface BackupRevealTargetRequest {
  /** Optional override; if omitted, opens the configured target. */
  path?: string;
}

export interface BackupRevealTargetResponse {
  ok: boolean;
  /** Resolved path that was opened. */
  path: string;
  error?: string;
}


export interface BackupHeartbeat {
  /** ISO timestamp when scripts/backup.cjs last ran successfully. Null if no heartbeat file yet. */
  lastBackupAt: string | null;
  /** Target directory the last backup was written to (helps when prompting "where's the USB?"). */
  target: string | null;
  /** Whether VACUUM INTO was used vs file-copy fallback. */
  usedVacuum: boolean | null;
  /** True if no heartbeat file has ever been written (never backed up). */
  neverBackedUp: boolean;
}

// --- Receipt customization (shop header / footer / layout) ---------------

export const IPC_CHANNELS_RECEIPT = {
  RECEIPT_GET_CONFIG: 'receipt:get-config',
  RECEIPT_SET_CONFIG: 'receipt:set-config',
  RECEIPT_TEST_PRINTER: 'receipt:test-printer',
} as const;

export type ReceiptPaperWidth = 58 | 80;
export type ReceiptDensity = 'compact' | 'normal' | 'spacious';

export interface ReceiptConfigResponse {
  shopName: string;
  shopSubtitle: string | null;
  headerLine3: string | null;
  headerLine4: string | null;
  footerText: string;
  /** node-thermal-printer interface used by desktop/counter sales. */
  counterPrinterInterface: string | null;
  /** node-thermal-printer interface used by phone/LAN sales at the door. */
  doorPrinterInterface: string | null;
  paperWidthMm: ReceiptPaperWidth;
  sideMarginMm: number;
  density: ReceiptDensity;
  bold: boolean;
  showCashier: boolean;
  showChannel: boolean;
  showCustomer: boolean;
  /** VAT build only: show the informational VAT/NHIL/GETFund block on receipts. */
  showVatBreakdown: boolean;
  /** VAT/TIN registration number printed on receipts in the VAT build. */
  vatRegistrationNumber: string | null;
}

export type ReceiptSetConfigRequest = ReceiptConfigResponse;

export interface ReceiptTestPrinterRequest {
  station: 'counter' | 'door';
}

export interface ReceiptTestPrinterResponse {
  ok: boolean;
  printed: boolean;
  error?: string;
}

// --- Wave C.1: Printable customer statement ------------------------------

export const IPC_CHANNELS_STATEMENT = {
  CUSTOMER_STATEMENT: 'customer:statement',
} as const;

export interface CustomerStatementRequest {
  customerId: string;
  /** ISO date YYYY-MM-DD; defaults to today. Statements include data up to and including this date. */
  asOfDate?: string;
  /** How many months of history to include. Default 6. */
  monthsOfHistory?: number;
}

export interface CustomerStatementInvoiceLine {
  saleId: string;
  shortRef: string;
  createdAt: string;
  totalPesewas: number;
  paidPesewas: number;
  outstandingPesewas: number;
  ageDays: number;
  bucket: 'current' | '0_30' | '31_60' | '61_90' | '90_plus';
}

export interface CustomerStatementPayment {
  paymentId: string;
  shortRef: string;
  receivedAt: string;
  amountPesewas: number;
  paymentMethod: string;
  paymentReference: string | null;
}

export interface CustomerStatementResponse {
  shop: { name: string; subtitle: string | null; phone: string | null };
  asOfDate: string;
  customer: {
    id: string;
    displayName: string;
    phone: string;
    customerType: string;
    creditLimitPesewas: number;
    blocked: boolean;
    blockedReason: string | null;
  };
  totals: {
    outstandingPesewas: number;
    bucket0_30: number;
    bucket31_60: number;
    bucket61_90: number;
    bucket90_plus: number;
    paidThisPeriodPesewas: number;
  };
  openInvoices: CustomerStatementInvoiceLine[];
  recentPayments: CustomerStatementPayment[];
  /** Suggested settle-by date for 31+ day balances (ISO YYYY-MM-DD). */
  pleaseSettleByDate: string;
}

// --- Wave C.2: Per-customer price overrides ------------------------------

export const IPC_CHANNELS_CPO = {
  CPO_LIST_FOR_CUSTOMER: 'cpo:list-for-customer',
  CPO_ADD: 'cpo:add',
  CPO_UPDATE: 'cpo:update',
  CPO_DEACTIVATE: 'cpo:deactivate',
} as const;

export interface CpoListRequest { customerId: string }
export interface CpoOverrideRow {
  id: string;
  customerId: string;
  productId: string;
  productName: string;
  appliesToUnitId: string;
  unitName: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  pricePesewas: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CpoListResponse { rows: CpoOverrideRow[] }

export interface CpoAddRequest {
  customerId: string;
  productId: string;
  appliesToUnitId: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  pricePesewas: number;
  notes?: string | null;
}
export interface CpoAddResponse { id: string }

export interface CpoUpdateRequest {
  id: string;
  pricePesewas?: number;
  notes?: string | null;
}
export interface CpoUpdateResponse { ok: true }

export interface CpoDeactivateRequest { id: string }
export interface CpoDeactivateResponse { ok: true }

// --- Wave C.3: Returns from customers ------------------------------------

export const IPC_CHANNELS_RETURNS = {
  RETURN_RECORD: 'return:record',
  RETURN_LIST_FOR_CUSTOMER: 'return:list-for-customer',
} as const;

export interface ReturnRecordRequest {
  customerId: string;
  originalSaleId?: string | null;
  refundMethod: 'CASH' | 'CREDIT';
  reason: string;
  notes?: string | null;
  lines: Array<{
    productId: string;
    unitId?: string | null;
    quantity: number;
    unitPricePesewas: number;
  }>;
  supervisorWorkerId: string;
  supervisorPin: string;
}

export interface ReturnRecordResponse {
  returnId: string;
  totalRefundPesewas: number;
  creditAllocations: Array<{ saleId: string; amountPesewas: number }>;
  negativeCashDropId: string | null;
}

export interface ReturnListRequest { customerId: string; limit?: number }
export interface ReturnListRow {
  id: string;
  customerId: string;
  customerName: string;
  originalSaleId: string | null;
  refundMethod: 'CASH' | 'CREDIT' | 'STORE';
  totalRefundPesewas: number;
  reason: string;
  createdAt: string;
  workerName: string;
  supervisorName: string;
}
export interface ReturnListResponse { rows: ReturnListRow[] }

// --- Supplier payments admin ---------------------------------------------

export const IPC_CHANNELS_SUP_PAY = {
  SUPPLIER_PAYMENT_LIST: 'supplier-payment:list',
  SUPPLIER_PAYMENT_RECORD: 'supplier-payment:record',
  SUPPLIER_STATEMENTS_LIST: 'supplier-payment:statements',
  SUPPLIER_INVOICE_LIST: 'supplier-payment:invoice-list',
  SUPPLIER_STATEMENT_LINES: 'supplier-payment:statement-lines',
} as const;

export interface SupplierPaymentRow {
  id: string;
  supplierId: string;
  supplierName: string;
  amountPesewas: number;
  paymentMethod: string;
  paymentReference: string | null;
  paidAt: string;
  approvedByWorkerId: string;
  approvedByName: string;
  notes: string | null;
  createdAt: string;
  allocatedPesewas: number;
}

export interface SupplierPaymentListRequest {
  supplierId?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
  offset?: number;
}

export interface SupplierPaymentListResponse {
  payments: SupplierPaymentRow[];
  totalCount: number;
}

export interface SupplierPaymentRecordRequest {
  supplierId: string;
  amountPesewas: number;
  paymentMethod: string;
  paymentReference?: string | null;
  paidAt?: string | null;
  allocations?: Array<{ supplierInvoiceId: string; amountPesewas: number }>;
  notes?: string | null;
}
export interface SupplierPaymentRecordResponse {
  paymentId: string;
  newSupplierBalancePesewas: number;
  totalAllocatedPesewas: number;
  unallocatedPesewas: number;
  allocations: Array<{ supplierInvoiceId: string; amountPesewas: number }>;
}

export interface SupplierStatementRow {
  supplierId: string;
  supplierName: string;
  active: boolean;
  paymentTermsDays: number;
  creditLimitPesewas: number;
  paymentSchedule: string;
  currentBalancePesewas: number;
  lifetimePaidPesewas: number;
  lifetimeReceivedCostPesewas: number;
  openInvoiceCount: number;
  overdueInvoiceCount: number;
  nextDueDate: string | null;
  lastPaidAt: string | null;
  lastReceiptAt: string | null;
}
export interface SupplierStatementsListRequest { includeInactive?: boolean }
export interface SupplierStatementsListResponse { rows: SupplierStatementRow[] }
export interface SupplierInvoiceRow {
  id: string; supplierId: string; supplierName: string;
  purchaseOrderId: string | null; invoiceNumber: string;
  invoiceDate: string; dueDate: string | null;
  totalPesewas: number; totalPaidPesewas: number; outstandingPesewas: number;
  status: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'DISPUTED' | 'VOID';
  notes: string | null; createdAt: string;
}
export interface SupplierInvoiceListRequest { supplierId?: string | null; includePaid?: boolean; limit?: number }
export interface SupplierInvoiceListResponse { invoices: SupplierInvoiceRow[] }
export interface SupplierStatementLinesRequest { supplierId: string; includePaid?: boolean }
export interface SupplierStatementLineRow {
  invoiceId: string; invoiceNumber: string; productSku: string; productName: string;
  quantity: number; canonicalQuantity: number; unitName: string | null;
  unitCostPesewas: number; lineTotalPesewas: number;
  allocatedTransportCostPesewas: number; allocatedLoadingCostPesewas: number;
  landedLineTotalPesewas: number;
}
export interface SupplierStatementLinesResponse { rows: SupplierStatementLineRow[] }

// --- Reports / overview dashboard ----------------------------------------

export const IPC_CHANNELS_REPORTS = {
  REPORTS_ACCESS_UNLOCK: 'reports:access-unlock',
  REPORTS_ACCESS_TOUCH: 'reports:access-touch',
  REPORTS_ACCESS_LOCK: 'reports:access-lock',
  REPORTS_ACCESS_STATUS: 'reports:access-status',
  REPORTS_ACCESS_ACTION: 'reports:access-action',
  REPORTS_OVERVIEW: 'reports:overview',
  REPORTS_SALES: 'reports:sales',
  REPORTS_GRAPHS: 'reports:graphs',
  REPORTS_MARGIN: 'reports:margin',
  REPORTS_INVENTORY: 'reports:inventory',
  REPORTS_PRICE_INTELLIGENCE: 'reports:price-intelligence',
  REPORTS_PRICE_HISTORY: 'reports:price-history',
  REPORTS_LANDED_COSTS: 'reports:landed-costs',
  REPORTS_CUSTOMER_INTELLIGENCE: 'reports:customer-intelligence',
  REPORTS_TAXES: 'reports:taxes',
  REPORTS_TAX_PAYMENT_RECORD: 'reports:tax-payment-record',
  REPORTS_BALANCE_SHEET: 'reports:balance-sheet',
  REPORTS_CASHFLOW: 'reports:cashflow',
  MANAGEMENT_ACCOUNTS_LIST: 'management:accounts-list',
  MANAGEMENT_ACCOUNT_CREATE: 'management:account-create',
  MANAGEMENT_ACCOUNT_UPDATE: 'management:account-update',
  MANAGEMENT_ACCOUNT_MAP: 'management:account-map',
  MANAGEMENT_ACCOUNT_RECONCILE: 'management:account-reconcile',
  MANAGEMENT_ACCOUNT_TRANSFER: 'management:account-transfer',
  MANAGEMENT_CUTOVER_PREVIEW: 'management:cutover-preview',
  MANAGEMENT_CUTOVER_ACTIVATE: 'management:cutover-activate',
  MANAGEMENT_SHADOW_STATUS: 'management:shadow-status',
  MANAGEMENT_SHADOW_SET: 'management:shadow-set',
  MANAGEMENT_DATA_QUALITY: 'management:data-quality',
  MANAGEMENT_INCOME_STATEMENT: 'management:income-statement',
  MANAGEMENT_POSITION: 'management:position',
  MANAGEMENT_CASHFLOW: 'management:cashflow',
  MANAGEMENT_OBLIGATIONS: 'management:obligations',
  MANAGEMENT_CONCENTRATION: 'management:concentration',
  MANAGEMENT_DOWNSIDE: 'management:downside',
  MANAGEMENT_EXPENSE_CREATE: 'management:expense-create',
  MANAGEMENT_LOAN_CREATE: 'management:loan-create',
  MANAGEMENT_OBLIGATION_PAY: 'management:obligation-pay',
  MANAGEMENT_OBLIGATION_UPDATE: 'management:obligation-update',
  MANAGEMENT_FIXED_ASSET_CREATE: 'management:fixed-asset-create',
  MANAGEMENT_FIXED_ASSETS_LIST: 'management:fixed-assets-list',
  MANAGEMENT_FIXED_ASSET_DEPRECIATE: 'management:fixed-asset-depreciate',
  MANAGEMENT_FIXED_ASSET_DISPOSE: 'management:fixed-asset-dispose',
  MANAGEMENT_THRESHOLD_UPDATE: 'management:threshold-update',
  MANAGEMENT_RISK_CONFIG: 'management:risk-config',
  MANAGEMENT_RISK_ASSUMPTION_SAVE: 'management:risk-assumption-save',
  MANAGEMENT_SCENARIO_SAVE: 'management:scenario-save',
  MANAGEMENT_DRILLDOWN: 'management:drilldown',
  MANAGEMENT_OWNER_CONTRIBUTION: 'management:owner-contribution',
  MANAGEMENT_HOME_WARNINGS: 'management:home-warnings',
} as const;

export type ReportAccessScope = 'OPERATIONAL' | 'OWNER';
export interface ReportsAccessUnlockRequest { pin: string }
export interface ReportsAccessUnlockResponse {
  accessToken: string;
  scopes: ReportAccessScope[];
  idleExpiresAt: string;
}
export interface ReportsAccessTokenRequest { accessToken: string }
export interface ReportsAccessLockRequest extends ReportsAccessTokenRequest {
  reason?: 'MANUAL' | 'IDLE';
}
export interface ReportsAccessTouchResponse { idleExpiresAt: string }
export interface ReportsAccessStatusResponse {
  unlocked: boolean;
  scopes: ReportAccessScope[];
  idleExpiresAt: string | null;
}
export interface ReportsAccessActionRequest extends ReportReadAccess {
  action: 'EXPORT' | 'PRINT';
  report: 'OWNER_MANAGEMENT_PACK' | 'BALANCE_SHEET' | 'CASHFLOW';
}
export interface ReportReadAccess { reportAccessToken: string }

export interface ReportsOverviewRequest extends ReportReadAccess {
  locationId?: string;
  /** Test/replay hook: override the "today" date. */
  asOfDateISO?: string;
}

export interface ReportsOverviewResponse {
  generatedAt: string;
  locationId: string;
  revenue: {
    todayPesewas: number; thisWeekPesewas: number; thisMonthPesewas: number;
    yesterdayPesewas: number; lastWeekPesewas: number; lastMonthPesewas: number;
    todayChangePct: number | null;
    thisWeekChangePct: number | null;
    thisMonthChangePct: number | null;
    numSalesToday: number; numSalesThisWeek: number; numSalesThisMonth: number;
  };
  margin: {
    revenuePesewas: number; cogsPesewas: number;
    grossMarginPesewas: number; grossMarginBps: number;
    revenueLast30dPesewas: number;
    grossMarginLast30dPesewas: number; grossMarginLast30dBps: number;
  };
  cashPosition: {
    openTillExpectedPesewas: number; openShifts: number;
    lastClosedVariancePesewas: number | null;
    lastClosedAt: string | null;
  };
  receivables: {
    totalPesewas: number;
    bucket0_30Pesewas: number; bucket31_60Pesewas: number;
    bucket61_90Pesewas: number; bucket90PlusPesewas: number;
    customerCount: number; overLimitCount: number;
  };
  payables: { totalOwedPesewas: number; supplierCount: number };
  inventory: {
    totalAtCostPesewas: number; totalAtRetailPesewas: number;
    activeSkuCount: number; belowReorderCount: number; stockoutCount: number;
  };
  revenueSparkline: Array<{ date: string; pesewas: number }>;
  topSellersThisWeek: Array<{
    productId: string; sku: string; name: string;
    unitsSold: number; revenuePesewas: number;
  }>;
  slowMovers: Array<{
    productId: string; sku: string; name: string;
    unitsOnHand: number; daysSinceLastSale: number | null;
    stockValueAtCostPesewas: number;
  }>;
  recentVarianceEvents: Array<{
    stocktakeId: string; completedAt: string;
    lossValuePesewas: number; foundValuePesewas: number;
    shrinkageRate: number | null;
    productsWithVariance: number;
  }>;
}

// --- Reports: Sales ------------------------------------------------------

export type ReportGroupBy = 'day' | 'week' | 'month';

export interface ReportsSalesRequest extends ReportReadAccess {
  fromDate: string;          // YYYY-MM-DD inclusive
  toDate: string;            // YYYY-MM-DD inclusive
  groupBy: ReportGroupBy;
}

export interface ReportsSalesResponse {
  fromDate: string;
  toDate: string;
  groupBy: ReportGroupBy;
  totalRevenuePesewas: number;
  totalNumSales: number;
  totalUniqueCustomers: number;
  totalAvgBasketPesewas: number | null;
  buckets: Array<{
    bucket: string;
    revenuePesewas: number;
    numSales: number;
    numUniqueCustomers: number;
    walkInPesewas: number;
    wholesalePesewas: number;
    routePesewas: number;
    avgBasketPesewas: number | null;
  }>;
  byChannel: Array<{ channel: string; revenuePesewas: number; numSales: number }>;
  byPaymentMethod: Array<{ method: string; revenuePesewas: number; numSales: number }>;
  byCashier: Array<{
    workerId: string; workerName: string;
    revenuePesewas: number; numSales: number;
    voidedCount: number;
  }>;
}

// --- Reports: Graphs -----------------------------------------------------

export interface ReportsGraphsRequest extends ReportReadAccess {
  fromDate: string;
  toDate: string;
}

export interface ReportsGraphsResponse {
  fromDate: string;
  toDate: string;
  totals: {
    revenuePesewas: number;
    netProfitPesewas: number;
    taxPayablePesewas: number;
    expensesPesewas: number;
    drawingsPesewas: number;
    supplierPaymentsPesewas: number;
    taxPaidPesewas: number;
    creditOutstandingPesewas: number;
    stockAtCostPesewas: number;
    numSales: number;
  };
  series: Array<{
    date: string;
    revenuePesewas: number;
    netProfitPesewas: number;
    taxPayablePesewas: number;
    expensesPesewas: number;
    drawingsPesewas: number;
    numSales: number;
  }>;
  topProductsByProfit: Array<{
    productId: string;
    sku: string;
    name: string;
    category: string;
    unitsSold: number;
    revenuePesewas: number;
    grossProfitPesewas: number;
    marginBps: number;
  }>;
  categoryProfit: Array<{
    category: string;
    revenuePesewas: number;
    grossProfitPesewas: number;
    marginBps: number;
  }>;
  slowStock: Array<{
    productId: string;
    sku: string;
    name: string;
    category: string;
    unitsOnHand: number;
    stockValuePesewas: number;
    daysSinceLastSale: number | null;
  }>;
  customerValue: Array<{
    customerId: string;
    name: string;
    revenuePesewas: number;
    numSales: number;
    avgBasketPesewas: number;
    lastPurchaseAt: string;
    abcClass: 'A' | 'B' | 'C';
  }>;
  creditAging: Array<{
    bucket: string;
    amountPesewas: number;
    customerCount: number;
  }>;
  expensesByCategory: Array<{ category: string; amountPesewas: number }>;
  drawingsByCategory: Array<{ category: string; amountPesewas: number }>;
  moneyOut: Array<{ kind: string; amountPesewas: number }>;
  stockoutForecast: Array<{
    productId: string;
    sku: string;
    name: string;
    category: string;
    unitsOnHand: number;
    unitsSold: number;
    avgDailyUnitsSold: number;
    daysCover: number | null;
    reorderThreshold: number;
    stockValuePesewas: number;
  }>;
  cashVarianceByWorker: Array<{
    workerId: string;
    workerName: string;
    closedShifts: number;
    netVariancePesewas: number;
    totalAbsoluteVariancePesewas: number;
    avgAbsoluteVariancePesewas: number;
    worstShortPesewas: number;
    worstOverPesewas: number;
  }>;
  deliveryByDay: Array<{
    date: string;
    deliveredCount: number;
    failedCount: number;
    deliveryFeePesewas: number;
    deliveryCostPesewas: number;
    deliveryProfitPesewas: number;
  }>;
  deliveryByDriver: Array<{
    driverId: string;
    driverName: string;
    deliveredCount: number;
    failedCount: number;
    deliveryFeePesewas: number;
    deliveryCostPesewas: number;
    deliveryProfitPesewas: number;
  }>;
}

// --- Reports: Margin -----------------------------------------------------

export interface ReportsMarginRequest extends ReportReadAccess {
  fromDate: string;
  toDate: string;
}

export interface ReportsMarginResponse {
  fromDate: string;
  toDate: string;
  totalRevenuePesewas: number;
  totalCogsPesewas: number;
  totalMarginPesewas: number;
  totalMarginBps: number;
  byProduct: Array<{
    productId: string; sku: string; name: string; category: string; brand: string | null;
    unitsSold: number;
    revenuePesewas: number; cogsPesewas: number; marginPesewas: number; marginBps: number;
  }>;
  byCategory: Array<{
    category: string;
    unitsSold: number;
    revenuePesewas: number; cogsPesewas: number; marginPesewas: number; marginBps: number;
    productCount: number;
  }>;
  belowCost: {
    numLines: number;
    totalLossPesewas: number;
    worst: Array<{
      saleId: string; saleAt: string;
      productId: string; sku: string; name: string;
      quantity: number;
      unitPricePesewas: number; unitCostPesewas: number; marginPesewas: number;
      workerName: string;
    }>;
  };
}

// --- Reports: Inventory --------------------------------------------------

export interface ReportsInventoryRequest extends ReportReadAccess {
  locationId?: string;
  velocityWindowDays?: number;
}

export interface ReportsInventoryResponse {
  generatedAt: string;
  locationId: string;
  velocityWindowDays: number;
  totalAtCostPesewas: number;
  totalAtRetailPesewas: number;
  activeSkuCount: number;
  stockoutCount: number;
  belowReorderCount: number;
  rows: Array<{
    productId: string; sku: string; name: string;
    category: string; brand: string | null;
    unitsOnHand: number;
    costPerUnitPesewas: number;
    retailPerUnitPesewas: number;
    totalAtCostPesewas: number;
    totalAtRetailPesewas: number;
    reorderThreshold: number;
    belowReorder: boolean;
    stockout: boolean;
    unitsSoldInWindow: number;
    daysOfSupply: number | null;
    lastReceivedAt: string | null;
    lastSoldAt: string | null;
  }>;
}

export interface ReportsTaxesRequest extends ReportReadAccess {
  fromDate: string;
  toDate: string;
}

export interface ReportsTaxesResponse {
  fromDate: string;
  toDate: string;
  salesInclusivePesewas: number;
  salesTaxablePesewas: number;
  outputVatPesewas: number;
  outputNhilPesewas: number;
  outputGetfundPesewas: number;
  outputTaxTotalPesewas: number;
  soldGoodsInclusiveCostPesewas: number;
  soldGoodsTaxableCostPesewas: number;
  purchaseInclusivePesewas: number;
  purchaseTaxablePesewas: number;
  inputVatPesewas: number;
  inputNhilPesewas: number;
  inputGetfundPesewas: number;
  inputTaxTotalPesewas: number;
  netVatPayablePesewas: number;
  taxPaidPesewas: number;
  taxBalancePesewas: number;
  saleCount: number;
  voidedSaleCount: number;
  voidedSalesInclusivePesewas: number;
  voidedOutputTaxTotalPesewas: number;
  supplierInvoiceCount: number;
  byDay: Array<{
    date: string;
    salesInclusivePesewas: number;
    outputTaxPesewas: number;
    voidedSalesInclusivePesewas: number;
    voidedOutputTaxPesewas: number;
    soldGoodsInclusiveCostPesewas: number;
    purchaseInclusivePesewas: number;
    inputTaxPesewas: number;
    netPayablePesewas: number;
  }>;
  voidedReceipts: Array<{
    saleId: string;
    saleAt: string;
    voidedAt: string;
    totalPesewas: number;
    outputTaxPesewas: number;
    voidReason: string | null;
    cashierName: string;
    voidedByName: string | null;
  }>;
  taxPayments: Array<{
    id: string;
    taxPeriodFrom: string;
    taxPeriodTo: string;
    amountPesewas: number;
    paymentMethod: string;
    paymentReference: string | null;
    paidAt: string;
    notes: string | null;
    workerName: string;
    shiftId: string | null;
  }>;
  supplierInputs: Array<{
    supplierId: string;
    supplierName: string;
    invoiceCount: number;
    purchaseInclusivePesewas: number;
    inputTaxPesewas: number;
  }>;
}

export interface ReportsTaxPaymentRecordRequest {
  pin: string;
  taxPeriodFrom: string;
  taxPeriodTo: string;
  amountPesewas: number;
  paymentMethod: 'CASH' | 'MOMO_MTN' | 'MOMO_VODAFONE' | 'MOMO_AIRTELTIGO' | 'BANK_TRANSFER';
  paymentReference?: string | null;
  paidAt?: string | null;
  notes?: string | null;
}
export interface ReportsTaxPaymentRecordResponse { paymentId: string }

export interface ReportsFinancialStatementLine {
  label: string;
  amountPesewas: number;
  note?: string | null;
}

export interface ReportsBalanceSheetRequest extends ReportReadAccess {
  asOfDate: string;
  locationId?: string;
}
export interface ReportsBalanceSheetResponse {
  generatedAt: string;
  asOfDate: string;
  locationId: string;
  assets: {
    totalPesewas: number;
    inventoryAtCostPesewas: number;
    customerReceivablesPesewas: number;
    openTillCashPesewas: number;
    taxCreditPesewas: number;
    lines: ReportsFinancialStatementLine[];
  };
  liabilities: {
    totalPesewas: number;
    supplierPayablesPesewas: number;
    taxPayablePesewas: number;
    customerCreditsPesewas: number;
    lines: ReportsFinancialStatementLine[];
  };
  equity: {
    totalPesewas: number;
    lines: ReportsFinancialStatementLine[];
  };
  caveats: string[];
}

export interface ReportsCashflowRequest extends ReportReadAccess {
  fromDate: string;
  toDate: string;
  locationId?: string;
}
export interface ReportsCashflowResponse {
  generatedAt: string;
  fromDate: string;
  toDate: string;
  locationId: string;
  inflows: {
    totalPesewas: number;
    lines: ReportsFinancialStatementLine[];
  };
  outflows: {
    totalPesewas: number;
    lines: ReportsFinancialStatementLine[];
  };
  netCashflowPesewas: number;
  transfers: {
    totalPesewas: number;
    lines: ReportsFinancialStatementLine[];
  };
  nonCash: {
    totalPesewas: number;
    lines: ReportsFinancialStatementLine[];
  };
  caveats: string[];
}

export interface ManagementDataQuality {
  status: 'COMPLETE' | 'PROVISIONAL' | 'INCOMPLETE';
  cutoverDate: string | null;
  issues: Array<{
    code: string;
    severity: 'WARNING' | 'BLOCKING';
    message: string;
    amountPesewas?: number;
  }>;
}

export interface ManagementLine {
  code: string;
  label: string;
  amountPesewas: number;
  comparisonPesewas?: number;
  note?: string | null;
}

export interface ManagementFinancialAccount {
  id: string;
  locationId: string;
  ledgerAccountId: string;
  ledgerAccountCode: string;
  name: string;
  kind: 'TILL' | 'SAFE' | 'BANK' | 'MOMO' | 'OTHER_CASH';
  provider: string | null;
  maskedIdentifier: string | null;
  allowNegative: boolean;
  active: boolean;
  balancePesewas: number;
  lastReconciledAt: string | null;
}

export interface ManagementAccountsListRequest extends ReportReadAccess { locationId?: string }
export interface ManagementAccountsListResponse {
  accounts: ManagementFinancialAccount[];
  ledgerAccounts: Array<{
    id: string; code: string; name: string; accountClass: string;
    accountSubtype: string; normalBalance: 'DEBIT' | 'CREDIT';
  }>;
  dataQuality: ManagementDataQuality;
}
export interface ManagementAccountCreateRequest {
  locationId?: string;
  name: string;
  kind: ManagementFinancialAccount['kind'];
  provider?: string | null;
  maskedIdentifier?: string | null;
  allowNegative?: boolean;
  pin: string;
}
export interface ManagementAccountUpdateRequest {
  financialAccountId: string;
  name: string;
  provider?: string | null;
  maskedIdentifier?: string | null;
  allowNegative?: boolean;
  active?: boolean;
  pin: string;
}
export interface ManagementAccountMapRequest {
  locationId?: string;
  paymentMethod: string;
  direction: 'IN' | 'OUT';
  financialAccountId: string;
  pin: string;
}
export interface ManagementAccountReconcileRequest {
  financialAccountId: string;
  observedPesewas: number;
  reconciledAt?: string;
  reference?: string | null;
  evidenceUrl?: string | null;
  notes?: string | null;
  pin: string;
}
export interface ManagementAccountTransferRequest {
  fromFinancialAccountId: string;
  toFinancialAccountId: string;
  amountPesewas: number;
  occurredAt?: string;
  reference?: string | null;
  notes?: string | null;
  pin: string;
}
export interface ManagementAccountReconcileResponse {
  reconciliationId: string;
  variancePesewas: number;
  adjustmentJournalEntryId: string | null;
}
export interface ManagementAccountTransferResponse {
  transferId: string;
  journalEntryId: string;
}
export interface ManagementExpenseCreateRequest {
  locationId?: string;
  category: string;
  payee?: string | null;
  incurredDate: string;
  dueDate?: string | null;
  amountPesewas: number;
  fixedOrVariable?: 'FIXED' | 'VARIABLE';
  financialAccountId?: string | null;
  paidAt?: string | null;
  paymentReference?: string | null;
  notes?: string | null;
  pin: string;
}
export interface ManagementExpenseCreateResponse {
  businessExpenseId: string;
  paymentId: string | null;
}
export interface ManagementLoanCreateRequest {
  locationId?: string;
  kind: 'BANK_LOAN' | 'OWNER_LOAN' | 'LEASE' | 'OTHER';
  creditorName: string;
  originalPrincipalPesewas: number;
  receivedFinancialAccountId?: string | null;
  startDate: string;
  endDate?: string | null;
  schedule: Array<{ dueDate: string; principalPesewas: number; interestPesewas?: number }>;
  notes?: string | null;
  pin: string;
}
export interface ManagementLoanCreateResponse {
  liabilityAgreementId: string;
  obligationIds: string[];
}
export interface ManagementObligationPayRequest {
  obligationId: string;
  financialAccountId: string;
  amountPesewas: number;
  paidAt?: string;
  reference?: string | null;
  notes?: string | null;
  pin: string;
}
export interface ManagementObligationPayResponse {
  allocationId: string;
  journalEntryId: string | null;
  principalPesewas: number;
  interestPesewas: number;
  outstandingPesewas: number;
}
export interface ManagementObligationUpdateRequest {
  obligationId: string;
  dueDate: string;
  disputed: boolean;
  notes?: string | null;
  pin: string;
}
export interface ManagementFixedAssetCreateRequest {
  locationId?: string;
  name: string;
  assetClass: string;
  acquiredDate: string;
  costPesewas: number;
  residualValuePesewas?: number;
  usefulLifeMonths?: number | null;
  sourceFinancialAccountId?: string | null;
  vendorName?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  pin: string;
}
export interface ManagementFixedAssetCreateResponse {
  fixedAssetId: string;
  journalEntryId: string | null;
}
export interface ManagementFixedAsset {
  id: string;
  locationId: string;
  name: string;
  assetClass: string;
  acquiredDate: string;
  costPesewas: number;
  residualValuePesewas: number;
  usefulLifeMonths: number | null;
  accumulatedDepreciationPesewas: number;
  carryingValuePesewas: number;
  disposedAt: string | null;
  disposalProceedsPesewas: number | null;
  notes: string | null;
}
export interface ManagementFixedAssetsListRequest extends ReportReadAccess { locationId?: string }
export interface ManagementFixedAssetsListResponse { assets: ManagementFixedAsset[] }
export interface ManagementFixedAssetDepreciateRequest {
  fixedAssetId: string;
  throughDate: string;
  pin: string;
}
export interface ManagementFixedAssetDepreciateResponse {
  journalEntryId: string;
  depreciationPesewas: number;
  accumulatedDepreciationPesewas: number;
}
export interface ManagementFixedAssetDisposeRequest {
  fixedAssetId: string;
  disposedDate: string;
  proceedsPesewas: number;
  receivingFinancialAccountId?: string | null;
  notes?: string | null;
  pin: string;
}
export interface ManagementFixedAssetDisposeResponse {
  journalEntryId: string;
  gainLossPesewas: number;
}
export interface ManagementThresholdUpdateRequest {
  locationId?: string;
  dimension: 'CUSTOMER' | 'PRODUCT' | 'SUPPLIER' | 'CATEGORY' | 'PAYMENT_RAIL';
  warningBps: number;
  dangerBps: number;
  pin: string;
}
export interface ManagementRiskAssumption {
  id: string;
  locationId: string;
  driver: string;
  baselineBps: number;
  downsideBps: number;
  rationale: string | null;
  ownerWorkerId: string | null;
  ownerName: string | null;
  reviewDate: string | null;
  active: boolean;
}
export interface ManagementScenarioDrivers {
  salesVolumeChangeBps: number;
  sellingPriceChangeBps: number;
  cogsChangeBps: number;
  fixedExpenseChangeBps: number;
  variableExpenseChangeBps: number;
  collectionChangeBps: number;
  badDebtBps: number;
  additionalInventoryLossBps: number;
  removeTopCustomer: boolean;
  removeTopProduct: boolean;
}
export interface ManagementSavedScenario {
  id: string;
  locationId: string;
  name: string;
  horizonDays: 30 | 90 | 180;
  drivers: Record<string, number | boolean>;
  active: boolean;
}
export interface ManagementRiskConfigRequest extends ReportReadAccess { locationId?: string }
export interface ManagementRiskConfigResponse {
  assumptions: ManagementRiskAssumption[];
  scenarios: ManagementSavedScenario[];
}
export interface ManagementRiskAssumptionSaveRequest {
  id?: string;
  locationId?: string;
  driver: string;
  baselineBps: number;
  downsideBps: number;
  rationale?: string | null;
  reviewDate?: string | null;
  active?: boolean;
  pin: string;
}
export interface ManagementScenarioSaveRequest {
  id?: string;
  locationId?: string;
  name: string;
  horizonDays: 30 | 90 | 180;
  drivers: ManagementScenarioDrivers;
  active?: boolean;
  pin: string;
}
export interface ManagementOwnerContributionRequest {
  financialAccountId: string;
  amountPesewas: number;
  receivedAt?: string;
  notes?: string | null;
  pin: string;
}
export interface ManagementOwnerContributionResponse {
  contributionId: string;
  journalEntryId: string;
}
export interface ManagementHomeWarningsResponse {
  overdueCount: number;
  overduePesewas: number;
  dueNext7DaysCount: number;
  dueNext7DaysPesewas: number;
  missingDueDateCount: number;
}
export interface ManagementCutoverBalance {
  ledgerAccountId: string;
  amountPesewas: number;
}
export interface ManagementCutoverRequest extends ReportReadAccess {
  locationId?: string;
  cutoverDate: string;
  balances: ManagementCutoverBalance[];
}
export interface ManagementCutoverActivateRequest {
  locationId?: string;
  cutoverDate: string;
  balances: ManagementCutoverBalance[];
  notes?: string | null;
  pin: string;
}
export interface ManagementCutoverPreviewResponse {
  locationId: string;
  cutoverDate: string;
  debitPesewas: number;
  creditPesewas: number;
  openingEquityPesewas: number;
  balances: Array<ManagementCutoverBalance & {
    code: string; name: string; accountClass: string; normalBalance: 'DEBIT' | 'CREDIT';
  }>;
  issues: ManagementDataQuality['issues'];
}
export interface ManagementCutoverActivateResponse {
  cutoverId: string;
  openingJournalEntryId: string;
  openingEquityPesewas: number;
}
export interface ManagementShadowRequest extends ReportReadAccess { locationId?: string }
export interface ManagementShadowSetRequest { locationId?: string; enabled: boolean; pin: string }
export interface ManagementShadowResponse {
  enabled: boolean;
  startedAt: string | null;
  status: 'NOT_RUNNING' | 'PASS' | 'FAIL';
  issues: Array<{ code: string; message: string; differencePesewas?: number }>;
  salesChecked: number;
  stockMovementsChecked: number;
}
export interface ManagementReportRangeRequest extends ReportReadAccess {
  fromDate: string;
  toDate: string;
  locationId?: string;
}
export interface ManagementAsOfRequest extends ReportReadAccess {
  asOfDate: string;
  locationId?: string;
}
export interface ManagementIncomeStatementResponse {
  generatedAt: string; fromDate: string; toDate: string; locationId: string;
  basis: 'ACCRUAL' | 'CASH'; legacyEstimate: boolean; dataQuality: ManagementDataQuality;
  accrual: {
    netSalesPesewas: number; cogsPesewas: number; grossProfitPesewas: number;
    grossMarginBps: number; otherOperatingIncomePesewas: number;
    operatingExpensesPesewas: number; inventoryLossesPesewas: number;
    operatingProfitPesewas: number; depreciationPesewas: number;
    financeCostsPesewas: number; profitBeforeIncomeTaxPesewas: number;
    incomeTaxExpensePesewas: number; netManagementProfitPesewas: number;
    comparisonNetManagementProfitPesewas: number; changePct: number | null;
    operatingExpenseLines: ManagementLine[]; inventoryLossLines: ManagementLine[];
  };
  cash: {
    customerCashReceivedPesewas: number; inventoryCashPaidPesewas: number;
    operatingExpensesPaidPesewas: number; taxPaidPesewas: number;
    cashOperatingSurplusPesewas: number; accrualToCashDifferencePesewas: number;
    reconciliationLines: ManagementLine[];
  };
}
export interface ManagementPositionResponse {
  generatedAt: string; asOfDate: string; locationId: string; legacyEstimate: boolean;
  dataQuality: ManagementDataQuality;
  assets: { totalPesewas: number; currentPesewas: number; lines: ManagementLine[] };
  liabilities: {
    totalPesewas: number; currentPesewas: number; nonCurrentPesewas: number;
    lines: ManagementLine[];
  };
  equity: { totalPesewas: number; lines: ManagementLine[] };
  workingCapitalPesewas: number; currentRatioBps: number | null;
  equationDifferencePesewas: number; integrityOk: boolean;
}
export interface ManagementCashflowResponse {
  generatedAt: string; fromDate: string; toDate: string; locationId: string;
  dataQuality: ManagementDataQuality;
  openingCashPesewas: number; operatingPesewas: number; investingPesewas: number;
  financingPesewas: number; netExternalCashflowPesewas: number;
  endingCashPesewas: number; expectedEndingCashPesewas: number;
  reconciliationDifferencePesewas: number; integrityOk: boolean;
  operatingLines: ManagementLine[]; investingLines: ManagementLine[];
  financingLines: ManagementLine[]; transferLines: ManagementLine[];
  accounts: ManagementFinancialAccount[];
}
export interface ManagementObligationsResponse {
  generatedAt: string; asOfDate: string; locationId: string;
  dataQuality: ManagementDataQuality;
  rows: Array<{
    id: string; obligationType: string; creditorName: string; sourceType: string;
    sourceId: string; issueDate: string; dueDate: string | null;
    principalPesewas: number; interestPesewas: number; paidPesewas: number;
    outstandingPesewas: number; status: string; disputed: boolean;
    bucket: string; daysUntilDue: number | null;
  }>;
  buckets: Array<{ bucket: string; amountPesewas: number; count: number }>;
  totalOutstandingPesewas: number; overduePesewas: number;
  dueNext7DaysPesewas: number; dueNext30DaysPesewas: number;
  availableReconciledCashPesewas: number; cashCoverageBps: number | null;
  projectedCoverageBps: number | null;
}
export interface ManagementConcentrationResponse {
  generatedAt: string; fromDate: string; toDate: string; locationId: string;
  dataQuality: ManagementDataQuality; identifiedCustomerRevenueBps: number;
  anonymousWalkInRevenuePesewas: number;
  dimensions: Array<{
    dimension: string; metric: string; totalPesewas: number;
    topOneBps: number; topThreeBps: number; topFiveBps: number;
    previousTopOneBps: number; changeBps: number; hhi: number;
    hhiLabel: string; risk: 'OK' | 'WARNING' | 'DANGER';
    warningBps: number; dangerBps: number;
    exposures: Array<{ id: string; name: string; amountPesewas: number; shareBps: number }>;
  }>;
}
export interface ManagementDownsideRequest extends ManagementAsOfRequest {
  horizonDays: 30 | 90 | 180;
  preset: 'BASELINE' | 'MILD' | 'SEVERE' | 'TOP_DEPENDENCY' | 'CUSTOM';
  drivers?: Partial<ManagementScenarioDrivers>;
}
export interface ManagementDownsideResponse {
  generatedAt: string; locationId: string;
  preset: ManagementDownsideRequest['preset']; horizonDays: 30 | 90 | 180;
  baselineFromDate: string; baselineToDate: string;
  dataQuality: ManagementDataQuality;
  drivers: ManagementScenarioDrivers;
  baseline: {
    revenuePesewas: number; grossProfitPesewas: number;
    operatingProfitPesewas: number; endingCashPesewas: number;
  };
  projected: {
    revenuePesewas: number; cogsPesewas: number; grossProfitPesewas: number;
    operatingExpensesPesewas: number; inventoryLossPesewas: number;
    badDebtPesewas: number; operatingProfitPesewas: number;
    cashOperatingSurplusPesewas: number; endingCashPesewas: number;
    minimumCashPesewas: number; cashRunwayDays: number | null;
    breakEvenRevenuePesewas: number | null; obligationsDuePesewas: number;
    obligationsCoverageBps: number | null; firstNegativeCashDate: string | null;
  };
  difference: {
    revenuePesewas: number; operatingProfitPesewas: number; endingCashPesewas: number;
  };
  monthly: Array<{
    month: number; revenuePesewas: number;
    operatingProfitPesewas: number; endingCashPesewas: number;
  }>;
  disclaimer: string;
}

export interface ManagementDrilldownRequest extends ReportReadAccess {
  locationId?: string;
  accountCode?: string;
  financialAccountId?: string;
  sourceType?: string;
  sourceId?: string;
  fromDate?: string;
  toDate?: string;
  asOfDate?: string;
}
export interface ManagementDrilldownResponse {
  generatedAt: string;
  locationId: string;
  rows: Array<{
    journalEntryId: string;
    businessDate: string;
    occurredAt: string;
    sourceType: string;
    sourceId: string;
    postingType: string;
    description: string;
    accountCode: string;
    accountName: string;
    debitPesewas: number;
    creditPesewas: number;
    amountPesewas: number;
    counterpartyType: string | null;
    counterpartyId: string | null;
  }>;
  truncated: boolean;
  legacyUnavailable: boolean;
}

export interface ReportsPriceIntelligenceResponse {
  rows: Array<{
    productId: string; sku: string; productName: string;
    costPricePesewas: number; minimumPricePesewas: number;
    walkInPricePesewas: number; wholesalePricePesewas: number; routePricePesewas: number;
    competitorPricePesewas: number | null; competitorName: string | null; competitorCheckedAt: string | null;
    walkInVsMinimumPesewas: number; walkInVsCompetitorPesewas: number | null;
  }>;
}
export interface ReportsPriceHistoryRequest extends ReportReadAccess {
  fromDate?: string; toDate?: string; productId?: string | null; limit?: number;
}
export interface ReportsPriceHistoryResponse {
  rows: Array<{
    id: string; productId: string; sku: string; productName: string;
    fieldName: string; oldPesewas: number | null; newPesewas: number | null;
    competitorName: string | null; reason: string | null; changedAt: string; changedBy: string;
  }>;
}
export interface ReportsLandedCostsRequest extends ReportReadAccess {
  fromDate?: string; toDate?: string; supplierId?: string | null;
}
export interface ReportsLandedCostsResponse {
  rows: Array<{
    invoiceId: string; invoiceNumber: string; supplierName: string;
    productId: string; sku: string; productName: string;
    lineTotalPesewas: number;
    allocatedTransportCostPesewas: number;
    allocatedLoadingCostPesewas: number;
    landedLineTotalPesewas: number;
  }>;
}
export interface ReportsCustomerIntelligenceRequest extends ReportReadAccess {
  asOfDateISO?: string; inactiveDays?: number;
}
export interface ReportsCustomerIntelligenceResponse {
  rows: Array<{
    customerId: string; name: string; phone: string | null;
    lastPurchaseAt: string | null; daysInactive: number | null;
    purchaseCount: number; purchaseFrequencyDays: number | null;
    totalValuePesewas: number; monthlyValuePesewas: number;
    abcClass: 'A' | 'B' | 'C';
  }>;
  inactive: Array<{
    customerId: string; name: string; phone: string | null;
    lastPurchaseAt: string | null; daysInactive: number | null;
    purchaseCount: number; purchaseFrequencyDays: number | null;
    totalValuePesewas: number; monthlyValuePesewas: number;
    abcClass: 'A' | 'B' | 'C';
  }>;
  topProducts: Array<{
    customerId: string; customerName: string; productId: string; sku: string;
    productName: string; unitsSold: number; revenuePesewas: number;
  }>;
}

// --- Catalog data transfer (export / import) -----------------------------
//
// Selective JSON export of the master-data tables (catalog only, no sales
// or operational history). Used to clone catalog state from one Counter
// instance to another — e.g. seeding a second shop from the first.
//
// Rows are keyed by natural keys at the file level (product SKU, supplier
// name, customer phone, unit name) so the file is portable across
// instances with different internal UUIDs. Internal `id` columns are NOT
// included in the file; the importer mints fresh UUIDs locally.

export const IPC_CHANNELS_CATALOG = {
  CATALOG_EXPORT: 'catalog:export',
  CATALOG_IMPORT_PICK: 'catalog:import-pick',
  CATALOG_IMPORT_APPLY: 'catalog:import-apply',
} as const;

/** Tables the user may opt into during export. */
export type CatalogTable =
  | 'suppliers' | 'products' | 'productUnits'
  | 'pricingTiers' | 'customers' | 'customerPriceOverrides';

export interface CatalogExportRequest {
  /** Tables to include. Default: all. */
  tables?: CatalogTable[];
  /** Include rows with active=0 / soft-deleted=false. Default: false. */
  includeInactive?: boolean;
}

export interface CatalogExportResponse {
  /** Where the file was written. */
  filePath: string;
  /** Bytes on disk. */
  sizeBytes: number;
  /** Per-table row counts in the file. */
  counts: Partial<Record<CatalogTable, number>>;
  /** Set if the user cancelled the save dialog. */
  cancelled?: boolean;
}

/** One supplier row in the export file. Natural key: name. */
export interface CatalogSupplier {
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  paymentTermsDays: number;
  notes: string | null;
  active: boolean;
}

/** One product. Natural key: sku. */
export interface CatalogProduct {
  sku: string;
  barcode: string | null;
  name: string;
  category: string;
  brand: string | null;
  packSizeUnits: number;
  unitVolumeMl: number | null;
  isReturnable: boolean;
  bottleDepositPesewas: number;
  costPricePesewas: number;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  reorderThreshold: number;
  reorderQuantity: number;
  defaultLeadTimeDays: number;
  shelfLifeDays: number | null;
  canonicalUnit: string;
  countClass: 'A' | 'B' | 'C' | null;
  active: boolean;
  /** Reference by supplier name (resolved at import). */
  primarySupplierName: string | null;
  /** Reference by product_units.unit_name (resolved after units are imported). */
  primaryPurchaseUnitName: string | null;
  primarySaleUnitName: string | null;
}

/** One product_unit. Natural key: (productSku, unitName). */
export interface CatalogProductUnit {
  productSku: string;
  unitName: string;
  conversionFactor: number;
  pricePesewas: number;
  isPurchaseUnit: boolean;
  isSaleUnit: boolean;
  displayOrder: number;
  notes: string | null;
  active: boolean;
}

/** Volume pricing tier. Natural key: (productSku, channel, minQuantity, appliesToUnitName). */
export interface CatalogPricingTier {
  productSku: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | 'ALL';
  minQuantity: number;
  unitPricePesewas: number;
  priority: number;
  appliesToUnitName: string | null;
  notes: string | null;
  active: boolean;
}

/** One customer. Natural key: phone (normalized). */
export interface CatalogCustomer {
  displayName: string;
  phone: string;
  alternatePhone: string | null;
  customerType: 'WALK_IN_REGULAR' | 'WHOLESALE' | 'ROUTE' | 'STAFF_FAMILY';
  businessName: string | null;
  locationDescription: string | null;
  geoLat: number | null;
  geoLng: number | null;
  creditLimitPesewas: number;
  creditTermsDays: number;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  blocked: boolean;
  blockedReason: string | null;
  notes: string | null;
}

/** Per-customer price override. Natural key: (customerPhone, productSku, unitName, channel). */
export interface CatalogCustomerPriceOverride {
  customerPhone: string;
  productSku: string;
  unitName: string;
  channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  pricePesewas: number;
  notes: string | null;
  active: boolean;
}

/** Top-level shape of an export file. */
export interface CatalogExportPayload {
  schemaVersion: 1;
  exportedAt: string;
  source: {
    deviceId: string;
    shopName: string | null;
    appVersion: string | null;
  };
  tables: {
    suppliers?: CatalogSupplier[];
    products?: CatalogProduct[];
    productUnits?: CatalogProductUnit[];
    pricingTiers?: CatalogPricingTier[];
    customers?: CatalogCustomer[];
    customerPriceOverrides?: CatalogCustomerPriceOverride[];
  };
}

/** Per-table summary returned for both dry-run and apply. */
export interface CatalogImportTableReport {
  table: CatalogTable;
  /** Rows in the file. */
  inFile: number;
  /** Rows that would be (or were) inserted. */
  toInsert: number;
  /** Rows that match an existing record by natural key. */
  matched: number;
  /** Rows that would be (or were) updated when updateExisting=true. */
  toUpdate: number;
  /** Rows skipped due to validation or because of missing FK targets. */
  skipped: number;
  /** Up to 20 human-readable reasons for skipped rows. */
  warnings: string[];
}

export interface CatalogImportPickResponse {
  /** Set if the user cancelled the open dialog. */
  cancelled?: boolean;
  filePath?: string;
  sizeBytes?: number;
  /** Parsed file header (without the rows). */
  header?: {
    schemaVersion: number;
    exportedAt: string;
    source: { deviceId: string; shopName: string | null; appVersion: string | null };
  };
  /** Per-table dry-run report. */
  report?: CatalogImportTableReport[];
  /** Set if the file failed to parse or is incompatible. */
  error?: string;
}

export interface CatalogImportApplyRequest {
  filePath: string;
  /** If true, overwrite existing rows on natural-key match. Default false. */
  updateExisting?: boolean;
  /** Subset of tables to apply. Default: all tables present in the file. */
  tables?: CatalogTable[];
}

export interface CatalogImportApplyResponse {
  ok: boolean;
  report: CatalogImportTableReport[];
  /** Wall-clock duration of the import transaction, ms. */
  durationMs: number;
  error?: string;
}

// --- Phase 4 workstream C: WhatsApp pending orders (accept/reject) --------

export const IPC_CHANNELS_PENDING_ORDERS = {
  PENDING_ORDERS_LIST: 'pending-orders:list',
  PENDING_ORDERS_DELIVERY_LIST: 'pending-orders:delivery-list',
  PENDING_ORDERS_GET: 'pending-orders:get',
  PENDING_ORDERS_RESOLVE_FOR_CART: 'pending-orders:resolve-for-cart',
  PENDING_ORDERS_REJECT: 'pending-orders:reject',
  PENDING_ORDERS_MARK_FULFILLED: 'pending-orders:mark-fulfilled',
  PENDING_ORDERS_MARK_PACKED: 'pending-orders:mark-packed',
  PENDING_ORDERS_MARK_DISPATCHED: 'pending-orders:mark-dispatched',
  PENDING_ORDERS_COMPLETE_DELIVERY: 'pending-orders:complete-delivery',
} as const;

export interface PendingOrderLine {
  productId: string;
  productName: string;
  unitId: string | null;
  unitName: string;
  quantity: number;
  unitPricePesewas: number;
  lineTotalPesewas: number;
}
export interface PendingOrderSummary {
  id: string;
  status: string;
  customerPhone: string;
  customerName: string | null;
  channel: string;
  totalPesewas: number;
  quoteExpiresAt: string | null;
  receivedAt: string;
  lineCount: number;
  deliveryStatus: string;
  driverId: string | null;
  driverName: string | null;
  deliveryFeePesewas: number;
  deliveryCostPesewas: number;
  deliveryProfitPesewas: number | null;
}
export interface PendingOrderDetail extends PendingOrderSummary {
  subtotalPesewas: number;
  confirmedAt: string | null;
  lines: PendingOrderLine[];
  fulfilledSaleId: string | null;
  rejectReason: string | null;
  packedAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveryFailedAt: string | null;
  deliveryFailureReason: string | null;
  deliveryConfirmationCode: string | null;
  deliveryConfirmationName: string | null;
}

export interface PendingOrdersListResponse { orders: PendingOrderSummary[] }
export interface PendingOrderGetRequest { orderId: string }
export interface PendingOrderRejectRequest { orderId: string; reason: string }
export interface PendingOrderMarkFulfilledRequest { orderId: string; saleId: string }
export interface PendingOrderMarkPackedRequest { orderId: string }
export interface PendingOrderMarkDispatchedRequest {
  orderId: string; driverId: string; deliveryFeePesewas?: number; deliveryCostPesewas?: number;
}
export interface PendingOrderCompleteDeliveryRequest {
  orderId: string; outcome: 'DELIVERED' | 'FAILED';
  confirmationCode?: string | null; confirmationName?: string | null; failureReason?: string | null;
}
export interface PendingOrderCompleteDeliveryResponse { deliveryProfitPesewas: number | null }

export interface ResolvedCartLine {
  productId: string;
  sku: string;
  name: string;
  unitId: string | null;
  unitName: string;
  factor: number;
  unitPricePesewas: number;
  quantity: number;
  unitsOnHand: number;
}
export interface ResolvedPendingOrder {
  orderId: string;
  channel: string;
  customerName: string | null;
  customerPhone: string;
  lines: ResolvedCartLine[];
}
