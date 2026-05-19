// Preload: the only bridge between renderer and main.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, IPC_CHANNELS_S5, IPC_CHANNELS_S6, IPC_CHANNELS_S7, IPC_CHANNELS_S8, IPC_CHANNELS_S9, IPC_CHANNELS_S11, IPC_CHANNELS_S11_SUP, IPC_CHANNELS_S12_AUDIT, IPC_CHANNELS_S12_BREAK, IPC_CHANNELS_S12_REPRINT, IPC_CHANNELS_S12_STOCK, IPC_CHANNELS_S14_REPRINT, IPC_CHANNELS_S15_PERIOD, IPC_CHANNELS_S15_EXC, IPC_CHANNELS_S16_REORDER, IPC_CHANNELS_S17_EXPENSES, IPC_CHANNELS_S18_RECOVERY, IPC_CHANNELS_BACKUP, IPC_CHANNELS_STATEMENT, IPC_CHANNELS_CPO, IPC_CHANNELS_RETURNS, IPC_CHANNELS_SUP_PAY, IPC_CHANNELS_REPORTS } from '../shared/types/ipc.js';
import type {
  BreakageReportRequest, CashDropRecordRequest, ConsumptionLogRequest,
  CustomerCreateRequest, CustomerUpdateRequest,
  DailySummaryGenerateRequest, DailySummaryGetRequest, DailySummaryListRequest,
  CustomerListByOutstandingRequest, CustomerRecordPaymentRequest,
  ProductUnitAddRequest, ProductUnitUpdateRequest,
  PricingTierAddRequest, PricingTierUpdateRequest,
  ProductAddRequest, ProductUpdateRequest,
  SaleCompleteRequest, SaleRepriceLinesRequest, StockReceiveRequest,
  StocktakeCompleteRequest, StocktakeRecordLineRequest,
  WorkerAddRequest,
  SetupCreateOwnerRequest,
  SupplierAddRequest, SupplierUpdateRequest,
  AuditListRequest,
  BreakageReviewListRequest,
  ReprintDiscardRequest, ReprintRetryRequest,
  SupplierPaymentListRequest, SupplierPaymentRecordRequest,
  SupplierStatementsListRequest,
  ReportsOverviewRequest,
  ReportsSalesRequest, ReportsMarginRequest, ReportsInventoryRequest,
} from '../shared/types/ipc.js';

const api = {
  // system
  ping: (echo?: string) => ipcRenderer.invoke(IPC_CHANNELS.PING, { echo }),
  getDeviceId: () => ipcRenderer.invoke(IPC_CHANNELS.GET_DEVICE_ID, {}),

  // auth
  listLoginCandidates: () => ipcRenderer.invoke(IPC_CHANNELS.WORKER_LIST_FOR_LOGIN, {}),
  login: (workerId: string, pin: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKER_LOGIN, { workerId, pin }),
  logout: () => ipcRenderer.invoke(IPC_CHANNELS.WORKER_LOGOUT, {}),
  getCurrentWorker: () => ipcRenderer.invoke(IPC_CHANNELS.WORKER_GET_CURRENT, {}),

  // shifts
  openShift: (openingCashPesewas: number, shiftType: 'COUNTER' | 'ROUTE') =>
    ipcRenderer.invoke(IPC_CHANNELS.SHIFT_OPEN, { openingCashPesewas, shiftType }),
  getOpenShift: () => ipcRenderer.invoke(IPC_CHANNELS.SHIFT_GET_OPEN, {}),
  submitClosingCount: (shiftId: string, countedPesewas: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHIFT_SUBMIT_COUNT, { shiftId, countedPesewas }),
  closeShift: (shiftId: string) => ipcRenderer.invoke(IPC_CHANNELS.SHIFT_CLOSE, { shiftId }),

  // sales
  searchProducts: (query: string, channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE', limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_SEARCH, { query, channel, limit }),
  getProductStock: (productId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PRODUCT_GET_STOCK, { productId }),
  searchCustomers: (query: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.CUSTOMER_SEARCH, { query, limit }),
  completeSale: (req: SaleCompleteRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.SALE_COMPLETE, req),
  repriceLines: (req: SaleRepriceLinesRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.SALE_REPRICE_LINES, req),

  // voids
  listRecentSales: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.SALE_LIST_RECENT, { limit }),
  voidSale: (saleId: string, reason: string, supervisorWorkerId: string, supervisorPin: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SALE_VOID, { saleId, reason, supervisorWorkerId, supervisorPin }),

  // breakage
  reportBreakage: (req: BreakageReportRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.BREAKAGE_REPORT, req),
  listRecentBreakage: () =>
    ipcRenderer.invoke(IPC_CHANNELS.BREAKAGE_LIST_RECENT, {}),

  // consumption
  getMonthlyUsage: (workerId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONSUMPTION_GET_USAGE, { workerId }),
  recordConsumption: (req: ConsumptionLogRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONSUMPTION_LOG, req),

  // stock receipts
  listSuppliers: () => ipcRenderer.invoke(IPC_CHANNELS.SUPPLIER_LIST, {}),
  receiveStock: (req: StockReceiveRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.STOCK_RECEIVE, req),

  // worker admin
  adminListWorkers: () => ipcRenderer.invoke(IPC_CHANNELS.WORKER_ADMIN_LIST, {}),
  addWorker: (req: WorkerAddRequest) => ipcRenderer.invoke(IPC_CHANNELS.WORKER_ADD, req),
  deactivateWorker: (workerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKER_DEACTIVATE, { workerId }),
  reactivateWorker: (workerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKER_REACTIVATE, { workerId }),
  terminateWorker: (workerId: string, reason: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKER_TERMINATE, { workerId, reason }),
  changePin: (oldPin: string, newPin: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKER_CHANGE_PIN, { oldPin, newPin }),
  resetPin: (workerId: string, newPin: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKER_RESET_PIN, { workerId, newPin }),

  // --- Session 5 ---
  startStocktake: (countClass?: 'A' | 'B' | 'C' | null) => ipcRenderer.invoke(IPC_CHANNELS_S5.STOCKTAKE_START, { countClass }),
  getActiveStocktake: () => ipcRenderer.invoke(IPC_CHANNELS_S5.STOCKTAKE_GET_ACTIVE, {}),
  recordStocktakeLine: (req: StocktakeRecordLineRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.STOCKTAKE_RECORD_LINE, req),
  completeStocktake: (req: StocktakeCompleteRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.STOCKTAKE_COMPLETE, req),
  cancelStocktake: (eventId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.STOCKTAKE_CANCEL, { eventId }),
  listRecentStocktakes: () => ipcRenderer.invoke(IPC_CHANNELS_S5.STOCKTAKE_LIST_RECENT, {}),
  getStocktakeWithLines: (eventId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.STOCKTAKE_GET_WITH_LINES, { eventId }),

  recordCashDrop: (req: CashDropRecordRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.CASH_DROP_RECORD, req),
  listCashDrops: (shiftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.CASH_DROP_LIST, { shiftId }),
  getExpectedCash: (shiftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.CASH_DROP_GET_EXPECTED, { shiftId }),

  generateDailySummary: (req: DailySummaryGenerateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.DAILY_SUMMARY_GENERATE, req),
  getDailySummary: (req: DailySummaryGetRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.DAILY_SUMMARY_GET, req),
  listDailySummaries: (req: DailySummaryListRequest = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS_S5.DAILY_SUMMARY_LIST, req),

  // --- Session 6: products + customers admin ---
  adminListProducts: () => ipcRenderer.invoke(IPC_CHANNELS_S6.PRODUCT_ADMIN_LIST, {}),
  addProduct: (req: ProductAddRequest) => ipcRenderer.invoke(IPC_CHANNELS_S6.PRODUCT_ADD, req),
  updateProduct: (req: ProductUpdateRequest) => ipcRenderer.invoke(IPC_CHANNELS_S6.PRODUCT_UPDATE, req),
  deactivateProduct: (productId: string) => ipcRenderer.invoke(IPC_CHANNELS_S6.PRODUCT_DEACTIVATE, { productId }),
  reactivateProduct: (productId: string) => ipcRenderer.invoke(IPC_CHANNELS_S6.PRODUCT_REACTIVATE, { productId }),
  createCustomer: (req: CustomerCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS_S6.CUSTOMER_CREATE, req),
  updateCustomer: (req: CustomerUpdateRequest) => ipcRenderer.invoke(IPC_CHANNELS_S6.CUSTOMER_UPDATE, req),
  blockCustomer: (customerId: string, reason: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S6.CUSTOMER_BLOCK, { customerId, reason }),
  unblockCustomer: (customerId: string) => ipcRenderer.invoke(IPC_CHANNELS_S6.CUSTOMER_UNBLOCK, { customerId }),

  // --- Session 7: pricing tiers + sale relookup ---
  listPricingTiersForProduct: (productId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S7.PRICING_TIER_LIST_FOR_PRODUCT, { productId }),
  addPricingTier: (req: PricingTierAddRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S7.PRICING_TIER_ADD, req),
  updatePricingTier: (req: PricingTierUpdateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S7.PRICING_TIER_UPDATE, req),
  deactivatePricingTier: (tierId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S7.PRICING_TIER_DEACTIVATE, { tierId }),
  reactivatePricingTier: (tierId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S7.PRICING_TIER_REACTIVATE, { tierId }),
  getBestPricingTier: (productId: string, channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE', quantity: number, unitId?: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS_S7.PRICING_TIER_GET_BEST, { productId, channel, quantity, unitId }),
  getSaleLines: (saleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S7.SALE_GET_LINES, { saleId }),

  // --- Session 8: customer credit + debt tracking ---
  customerOverview: (customerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S8.CUSTOMER_OVERVIEW, { customerId }),
  customerOpenSales: (customerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S8.CUSTOMER_OPEN_SALES, { customerId }),
  recordCustomerPayment: (req: CustomerRecordPaymentRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S8.CUSTOMER_RECORD_PAYMENT, req),
  listCustomersByOutstanding: (req: CustomerListByOutstandingRequest = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS_S8.CUSTOMER_LIST_BY_OUTSTANDING, req),
  customerAgingSummary: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S8.CUSTOMER_AGING_SUMMARY, {}),
  reconcileCustomer: (customerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S8.CUSTOMER_RECONCILE, { customerId }),

  // --- Session 9b: product units UI surface ---
  listProductUnits: (productId: string, activeOnly?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS_S9.PRODUCT_UNIT_LIST_FOR_PRODUCT, { productId, activeOnly }),
  addProductUnit: (req: ProductUnitAddRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S9.PRODUCT_UNIT_ADD, req),
  updateProductUnit: (req: ProductUnitUpdateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S9.PRODUCT_UNIT_UPDATE, req),
  deactivateProductUnit: (unitId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S9.PRODUCT_UNIT_DEACTIVATE, { unitId }),
  reactivateProductUnit: (unitId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S9.PRODUCT_UNIT_REACTIVATE, { unitId }),

  // --- Session 11: first-run setup ---
  setupNeedsOwner: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S11.SETUP_NEEDS_OWNER, {}),
  setupCreateOwner: (req: SetupCreateOwnerRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S11.SETUP_CREATE_OWNER, req),

  // --- Session 11: suppliers admin ---
  listSuppliersForAdmin: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S11_SUP.SUPPLIER_ADMIN_LIST, {}),
  addSupplier: (req: SupplierAddRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S11_SUP.SUPPLIER_ADD, req),
  updateSupplier: (req: SupplierUpdateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S11_SUP.SUPPLIER_UPDATE, req),
  deactivateSupplier: (supplierId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S11_SUP.SUPPLIER_DEACTIVATE, { supplierId }),
  reactivateSupplier: (supplierId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S11_SUP.SUPPLIER_REACTIVATE, { supplierId }),

  // --- Session 12: audit log viewer ---
  listAuditEntries: (req: AuditListRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_AUDIT.AUDIT_LIST, req),
  listAuditActions: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_AUDIT.AUDIT_LIST_ACTIONS, {}),
  listAuditEntityTypes: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_AUDIT.AUDIT_LIST_ENTITY_TYPES, {}),

  // --- Session 12: breakage review ---
  reviewBreakage: (req: BreakageReviewListRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_BREAK.BREAKAGE_REVIEW_LIST, req),
  reviewBreakageCauses: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_BREAK.BREAKAGE_REVIEW_CAUSES, {}),
  getBreakagePhoto: (relativePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_BREAK.BREAKAGE_PHOTO_DATA, { relativePath }),

  // --- Session 12: pending receipt reprints ---
  listPendingReprints: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_REPRINT.REPRINT_LIST, {}),
  retryReprint: (req: ReprintRetryRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_REPRINT.REPRINT_RETRY, req),
  discardReprint: (req: ReprintDiscardRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_REPRINT.REPRINT_DISCARD, req),
  pendingReprintCount: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_REPRINT.REPRINT_PENDING_COUNT, {}),

  // --- Session 12: stock movement history ---
  stockHistoryForProduct: (productId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS_S12_STOCK.STOCK_HISTORY_FOR_PRODUCT, { productId, limit }),

  // --- Session 14: on-demand receipt reprint ---
  reprintSaleReceipt: (saleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S14_REPRINT.SALE_REPRINT_RECEIPT, { saleId }),
  getSaleReceipt: (saleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S14_REPRINT.SALE_GET_RECEIPT, { saleId }),

  // --- Session 15: period close ---
  periodGetActiveClose: (businessDate: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_PERIOD.PERIOD_GET_ACTIVE_CLOSE, { businessDate }),
  periodListCloses: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_PERIOD.PERIOD_LIST_CLOSES, {}),
  periodSeal: (businessDate: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_PERIOD.PERIOD_SEAL, { businessDate }),
  periodReopen: (businessDate: string, reason: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_PERIOD.PERIOD_REOPEN, { businessDate, reason }),

  // --- Session 15: exception reports ---
  excVoidsByCashier: (fromDate: string, toDate: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_EXC.EXC_VOIDS_BY_CASHIER, { fromDate, toDate }),
  excDiscountsByCashier: (fromDate: string, toDate: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_EXC.EXC_DISCOUNTS_BY_CASHIER, { fromDate, toDate }),
  excPostSaleEdits: (fromDate: string, toDate: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_EXC.EXC_POST_SALE_EDITS, { fromDate, toDate }),
  excRepeatedSkuVoids: (fromDate: string, toDate: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_EXC.EXC_REPEATED_SKU_VOIDS, { fromDate, toDate }),
  excLargeDiscounts: (fromDate: string, toDate: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S15_EXC.EXC_LARGE_DISCOUNTS, { fromDate, toDate }),

  // --- Session 16: reorder PO suggestions ---
  reorderSuggest: (supplierId?: string | null, safetyMultiplier?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS_S16_REORDER.REORDER_SUGGEST,
      supplierId === undefined ? { safetyMultiplier } : { supplierId, safetyMultiplier }),
  reorderCreateDraftPO: (req: { supplierId: string; lines: Array<{ productId: string; quantity: number; unitCostPesewas: number }>; notes?: string | null; expectedDeliveryDate?: string | null }) =>
    ipcRenderer.invoke(IPC_CHANNELS_S16_REORDER.REORDER_CREATE_DRAFT_PO, req),
  reorderListDrafts: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S16_REORDER.REORDER_LIST_DRAFTS, {}),

  // --- Session 17: petty cash expenses ---
  recordExpense: (req: any) =>
    ipcRenderer.invoke(IPC_CHANNELS_S17_EXPENSES.EXPENSE_RECORD, req),
  listExpensesForShift: (shiftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S17_EXPENSES.EXPENSE_LIST_FOR_SHIFT, { shiftId }),
  expenseTotalsForShift: (shiftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S17_EXPENSES.EXPENSE_TOTALS_FOR_SHIFT, { shiftId }),

  // --- Session 18: OWNER recovery code ---
  recoveryListOwners: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S18_RECOVERY.RECOVERY_LIST_OWNERS, {}),
  recoveryResetPin: (workerId: string, recoveryCode: string, newPin: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_S18_RECOVERY.RECOVERY_RESET_PIN, { workerId, recoveryCode, newPin }),
  recoveryRegenerate: () =>
    ipcRenderer.invoke(IPC_CHANNELS_S18_RECOVERY.RECOVERY_REGENERATE, {}),

  // --- Wave B.2: Off-site backup heartbeat ---
  backupGetHeartbeat: () =>
    ipcRenderer.invoke(IPC_CHANNELS_BACKUP.BACKUP_GET_HEARTBEAT, {}),

  // --- Wave C.1: Printable customer statement ---
  customerStatement: (customerId: string, asOfDate?: string, monthsOfHistory?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS_STATEMENT.CUSTOMER_STATEMENT, { customerId, asOfDate, monthsOfHistory }),

  // --- Wave C.2: Per-customer price overrides ---
  cpoListForCustomer: (customerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_CPO.CPO_LIST_FOR_CUSTOMER, { customerId }),
  cpoAdd: (req: {
    customerId: string; productId: string; appliesToUnitId: string;
    channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
    pricePesewas: number; notes?: string | null;
  }) => ipcRenderer.invoke(IPC_CHANNELS_CPO.CPO_ADD, req),
  cpoUpdate: (id: string, pricePesewas?: number, notes?: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS_CPO.CPO_UPDATE, { id, pricePesewas, notes }),
  cpoDeactivate: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS_CPO.CPO_DEACTIVATE, { id }),

  // --- Wave C.3: Customer returns ---
  recordReturn: (req: {
    customerId: string;
    originalSaleId?: string | null;
    refundMethod: 'CASH' | 'CREDIT';
    reason: string;
    notes?: string | null;
    lines: Array<{ productId: string; unitId?: string | null; quantity: number; unitPricePesewas: number }>;
    supervisorWorkerId: string;
    supervisorPin: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS_RETURNS.RETURN_RECORD, req),
  listReturnsForCustomer: (customerId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS_RETURNS.RETURN_LIST_FOR_CUSTOMER, { customerId, limit }),

  // --- Supplier payments ---
  listSupplierPayments: (req: SupplierPaymentListRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_SUP_PAY.SUPPLIER_PAYMENT_LIST, req),
  recordSupplierPayment: (req: SupplierPaymentRecordRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_SUP_PAY.SUPPLIER_PAYMENT_RECORD, req),
  listSupplierStatements: (req: SupplierStatementsListRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_SUP_PAY.SUPPLIER_STATEMENTS_LIST, req),

  // --- Reports / dashboard ---
  reportsOverview: (req: ReportsOverviewRequest = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS_REPORTS.REPORTS_OVERVIEW, req),
  reportsSales: (req: ReportsSalesRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_REPORTS.REPORTS_SALES, req),
  reportsMargin: (req: ReportsMarginRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS_REPORTS.REPORTS_MARGIN, req),
  reportsInventory: (req: ReportsInventoryRequest = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS_REPORTS.REPORTS_INVENTORY, req),
};

contextBridge.exposeInMainWorld('counter', api);

export type CounterApi = typeof api;
