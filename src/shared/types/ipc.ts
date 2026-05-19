// Typed IPC contracts. Renderer -> main only.

export const IPC_CHANNELS = {
  // System
  PING: 'system:ping',
  GET_DEVICE_ID: 'system:device-id',

  // Auth / session
  WORKER_LIST_FOR_LOGIN: 'worker:list-for-login',
  WORKER_LOGIN: 'worker:login',
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

  // Voids
  SALE_LIST_RECENT: 'sale:list-recent',
  SALE_VOID: 'sale:void',

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

// --- auth ------------------------------------------------------------------

export interface ListLoginCandidatesResponse {
  workers: Array<{ id: string; fullName: string; role: string }>;
}
export interface WorkerLoginRequest { workerId: string; pin: string }
export type WorkerLoginResponse =
  | { ok: true; workerId: string; fullName: string; role: string }
  | { ok: false; reason: 'INVALID_PIN'; attemptsRemaining: number }
  | { ok: false; reason: 'LOCKED_OUT'; lockedUntil: string }
  | { ok: false; reason: 'UNKNOWN_WORKER' }
  | { ok: false; reason: 'SYSTEM_ROLE_REJECTED' };
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
export interface ShiftCloseRequest { shiftId: string }
export interface ShiftCloseResponse {
  shiftId: string;
  countedPesewas: number;
  expectedPesewas: number;
  variancePesewas: number;
  totalSalesPesewas: number;
  totalBreakageValuePesewas: number;
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
    id: string; sku: string; name: string; brand: string | null; category: string;
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

// --- voids -----------------------------------------------------------------

export interface SaleListRecentRequest { limit?: number }
export interface SaleListRecentResponse {
  sales: Array<{
    id: string; createdAt: string; channel: string; totalPesewas: number;
    paymentMethod: string; workerName: string; customerName: string | null;
    voided: boolean; lineCount: number;
  }>;
}
export interface SaleVoidRequest {
  saleId: string;
  reason: string;
  supervisorWorkerId: string;
  supervisorPin: string;
}
export interface SaleVoidResponse {
  saleId: string;
  reversalMovementCount: number;
  customerBalanceDelta: number;
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
  lines: Array<{ productId: string; quantity: number; unitCostPesewas: number; unitId?: string | null }>;
  notes?: string | null;
}
export interface StockReceiveResponse {
  movementCount: number;
  totalValuePesewas: number;
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
  supervisorWorkerId: string; supervisorPin: string;
}
export interface CashDropRecordResponse { cashCountId: string; expectedCashAfterDropPesewas: number }
export interface CashDropListRequest { shiftId: string }
export interface CashDropListResponse {
  drops: Array<{ id: string; amountPesewas: number; notes: string | null;
    supervisorId: string | null; createdAt: string; workerName: string;
    supervisorName: string | null }>;
}
export interface CashDropGetExpectedRequest { shiftId: string }
export interface CashDropGetExpectedResponse { expectedCashPesewas: number }

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
} as const;

export interface CustomerOverviewRequest { customerId: string }
export interface CustomerOverviewResponse {
  id: string; displayName: string; phone: string; customerType: string;
  creditLimitPesewas: number;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  cachedBalancePesewas: number; trueBalancePesewas: number; driftPesewas: number;
  blocked: boolean; blockedReason: string | null;
  utilizationBps: number;
  ageOfOldestUnpaidDays: number | null;
  agingBuckets: { bucket0_30: number; bucket31_60: number; bucket61_90: number; bucket90_plus: number };
  recentSales: Array<{ id: string; createdAt: string; totalPesewas: number; amountOutstandingPesewas: number; voided: boolean }>;
  recentPayments: Array<{ id: string; receivedAt: string; amountPesewas: number; paymentMethod: string; paymentReference: string | null }>;
}

export interface CustomerOpenSalesRequest { customerId: string }
export interface CustomerOpenSalesResponse {
  sales: Array<{ saleId: string; createdAt: string; totalPesewas: number; paidPesewas: number; outstandingPesewas: number; ageDays: number }>;
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
export interface ExcVoidsByCashierResponse { rows: CashierVoidRow[] }
export interface ExcDiscountsByCashierResponse { rows: CashierDiscountRow[] }
export interface ExcPostSaleEditsResponse { rows: PostSaleEditRow[] }
export interface ExcRepeatedSkuVoidsResponse { rows: RepeatedSkuVoidRow[] }
export interface ExcLargeDiscountsResponse { rows: LargeDiscountRow[] }

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
  | 'COMMS' | 'REPAIRS' | 'BANK_FEES' | 'OTHER';

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
} as const;

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
  notes?: string | null;
}
export interface SupplierPaymentRecordResponse {
  paymentId: string;
  newSupplierBalancePesewas: number;
}

export interface SupplierStatementRow {
  supplierId: string;
  supplierName: string;
  active: boolean;
  paymentTermsDays: number;
  currentBalancePesewas: number;
  lifetimePaidPesewas: number;
  lifetimeReceivedCostPesewas: number;
  lastPaidAt: string | null;
  lastReceiptAt: string | null;
}
export interface SupplierStatementsListRequest { includeInactive?: boolean }
export interface SupplierStatementsListResponse { rows: SupplierStatementRow[] }

// --- Reports / overview dashboard ----------------------------------------

export const IPC_CHANNELS_REPORTS = {
  REPORTS_OVERVIEW: 'reports:overview',
  REPORTS_SALES: 'reports:sales',
  REPORTS_MARGIN: 'reports:margin',
  REPORTS_INVENTORY: 'reports:inventory',
} as const;

export interface ReportsOverviewRequest {
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

export interface ReportsSalesRequest {
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

// --- Reports: Margin -----------------------------------------------------

export interface ReportsMarginRequest {
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

export interface ReportsInventoryRequest {
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

