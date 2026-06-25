// The single source of truth for the Counter RPC surface.
//
// Both transports build the renderer-facing API from this one factory:
//   - preload.ts wires `invoke` to ipcRenderer.invoke (Electron desktop)
//   - the browser/LAN client (Phase 1) wires `invoke` to fetch('/api/...')
//
// Each method owns its channel + arg→payload shaping and its typed response,
// so the renderer's view of the API and the runtime mapping can never drift
// apart. `CounterApi` is derived from the return type — do not hand-maintain a
// parallel interface.

import * as ipc from './types/ipc.js';

/** Transport primitive: send a payload to a channel, get the typed envelope
 *  back. Implementations decide how the bytes move (IPC, HTTP, a test stub). */
export type Invoke = <T = unknown>(
  channel: string,
  payload?: unknown,
) => Promise<ipc.IpcResponse<T>>;

type Channel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export function createCounterApi(invoke: Invoke) {
  return {
    // system
    ping: (echo?: string) => invoke<ipc.PingResponse>(ipc.IPC_CHANNELS.PING, { echo }),
    getDeviceId: () => invoke<ipc.GetDeviceIdResponse>(ipc.IPC_CHANNELS.GET_DEVICE_ID, {}),
    getAccessInfo: () => invoke<ipc.AccessInfoResponse>(ipc.IPC_CHANNELS.NET_ACCESS_INFO, {}),
    syncGetStatus: () => invoke<ipc.SyncStatus>(ipc.IPC_CHANNELS_SYNC.SYNC_GET_STATUS, {}),
    syncGetConfig: () => invoke<ipc.SyncConfigView>(ipc.IPC_CHANNELS_SYNC.SYNC_GET_CONFIG, {}),
    syncSetConfig: (req: ipc.SyncSetConfigRequest) => invoke<ipc.SyncConfigView>(ipc.IPC_CHANNELS_SYNC.SYNC_SET_CONFIG, req),

    // auth
    listLoginCandidates: () => invoke<ipc.ListLoginCandidatesResponse>(ipc.IPC_CHANNELS.WORKER_LIST_FOR_LOGIN, {}),
    login: (workerId: string, pin: string) => invoke<ipc.WorkerLoginResponse>(ipc.IPC_CHANNELS.WORKER_LOGIN, { workerId, pin }),
    logout: () => invoke<ipc.WorkerLogoutResponse>(ipc.IPC_CHANNELS.WORKER_LOGOUT, {}),
    getCurrentWorker: () => invoke<ipc.WorkerGetCurrentResponse>(ipc.IPC_CHANNELS.WORKER_GET_CURRENT, {}),

    // shifts
    openShift: (openingCashPesewas: number, shiftType: 'COUNTER' | 'ROUTE') =>
      invoke<ipc.ShiftOpenResponse>(ipc.IPC_CHANNELS.SHIFT_OPEN, { openingCashPesewas, shiftType }),
    getOpenShift: () => invoke<ipc.ShiftGetOpenResponse>(ipc.IPC_CHANNELS.SHIFT_GET_OPEN, {}),
    submitClosingCount: (shiftId: string, countedPesewas: number) =>
      invoke<ipc.ShiftSubmitCountResponse>(ipc.IPC_CHANNELS.SHIFT_SUBMIT_COUNT, { shiftId, countedPesewas }),
    closeShift: (shiftId: string) => invoke<ipc.ShiftCloseResponse>(ipc.IPC_CHANNELS.SHIFT_CLOSE, { shiftId }),

    // sales
    searchProducts: (query: string, channel: Channel, limit?: number) =>
      invoke<ipc.ProductSearchResponse>(ipc.IPC_CHANNELS.PRODUCT_SEARCH, { query, channel, limit }),
    getProductStock: (productId: string) =>
      invoke<ipc.ProductGetStockResponse>(ipc.IPC_CHANNELS.PRODUCT_GET_STOCK, { productId }),
    searchCustomers: (query: string, limit?: number) =>
      invoke<ipc.CustomerSearchResponse>(ipc.IPC_CHANNELS.CUSTOMER_SEARCH, { query, limit }),
    completeSale: (req: ipc.SaleCompleteRequest) =>
      invoke<ipc.SaleCompleteResponse>(ipc.IPC_CHANNELS.SALE_COMPLETE, req),
    repriceLines: (req: ipc.SaleRepriceLinesRequest) =>
      invoke<ipc.SaleRepriceLinesResponse>(ipc.IPC_CHANNELS.SALE_REPRICE_LINES, req),

    // voids
    listRecentSales: (limit?: number) =>
      invoke<ipc.SaleListRecentResponse>(ipc.IPC_CHANNELS.SALE_LIST_RECENT, { limit }),
    voidSale: (saleId: string, reason: string, supervisorWorkerId: string, supervisorPin: string) =>
      invoke<ipc.SaleVoidResponse>(ipc.IPC_CHANNELS.SALE_VOID, { saleId, reason, supervisorWorkerId, supervisorPin }),
    correctSale: (req: ipc.SaleCorrectRequest) =>
      invoke<ipc.SaleCorrectResponse>(ipc.IPC_CHANNELS.SALE_CORRECT, req),

    // breakage
    reportBreakage: (req: ipc.BreakageReportRequest) =>
      invoke<ipc.BreakageReportResponse>(ipc.IPC_CHANNELS.BREAKAGE_REPORT, req),
    listRecentBreakage: () =>
      invoke<ipc.BreakageListRecentResponse>(ipc.IPC_CHANNELS.BREAKAGE_LIST_RECENT, {}),

    // consumption
    getMonthlyUsage: (workerId?: string) =>
      invoke<ipc.ConsumptionGetUsageResponse>(ipc.IPC_CHANNELS.CONSUMPTION_GET_USAGE, { workerId }),
    recordConsumption: (req: ipc.ConsumptionLogRequest) =>
      invoke<ipc.ConsumptionLogResponse>(ipc.IPC_CHANNELS.CONSUMPTION_LOG, req),

    // stock receipts
    listSuppliers: () => invoke<ipc.SupplierListResponse>(ipc.IPC_CHANNELS.SUPPLIER_LIST, {}),
    receiveStock: (req: ipc.StockReceiveRequest) =>
      invoke<ipc.StockReceiveResponse>(ipc.IPC_CHANNELS.STOCK_RECEIVE, req),

    // worker admin
    adminListWorkers: () => invoke<ipc.WorkerAdminListResponse>(ipc.IPC_CHANNELS.WORKER_ADMIN_LIST, {}),
    addWorker: (req: ipc.WorkerAddRequest) => invoke<ipc.WorkerAddResponse>(ipc.IPC_CHANNELS.WORKER_ADD, req),
    deactivateWorker: (workerId: string) =>
      invoke<ipc.WorkerSimpleResponse>(ipc.IPC_CHANNELS.WORKER_DEACTIVATE, { workerId }),
    reactivateWorker: (workerId: string) =>
      invoke<ipc.WorkerSimpleResponse>(ipc.IPC_CHANNELS.WORKER_REACTIVATE, { workerId }),
    terminateWorker: (workerId: string, reason: string) =>
      invoke<ipc.WorkerSimpleResponse>(ipc.IPC_CHANNELS.WORKER_TERMINATE, { workerId, reason }),
    changePin: (oldPin: string, newPin: string) =>
      invoke<ipc.WorkerSimpleResponse>(ipc.IPC_CHANNELS.WORKER_CHANGE_PIN, { oldPin, newPin }),
    resetPin: (workerId: string, newPin: string) =>
      invoke<ipc.WorkerSimpleResponse>(ipc.IPC_CHANNELS.WORKER_RESET_PIN, { workerId, newPin }),

    // --- Session 5: stocktake / cash drops / daily summary ---
    startStocktake: (countClass?: 'A' | 'B' | 'C' | null) =>
      invoke<ipc.StocktakeStartResponse>(ipc.IPC_CHANNELS_S5.STOCKTAKE_START, { countClass }),
    getActiveStocktake: () => invoke<ipc.StocktakeGetActiveResponse>(ipc.IPC_CHANNELS_S5.STOCKTAKE_GET_ACTIVE, {}),
    recordStocktakeLine: (req: ipc.StocktakeRecordLineRequest) =>
      invoke<ipc.StocktakeRecordLineResponse>(ipc.IPC_CHANNELS_S5.STOCKTAKE_RECORD_LINE, req),
    completeStocktake: (req: ipc.StocktakeCompleteRequest) =>
      invoke<ipc.StocktakeCompleteResponse>(ipc.IPC_CHANNELS_S5.STOCKTAKE_COMPLETE, req),
    cancelStocktake: (eventId: string) =>
      invoke<ipc.StocktakeCancelResponse>(ipc.IPC_CHANNELS_S5.STOCKTAKE_CANCEL, { eventId }),
    listRecentStocktakes: () => invoke<ipc.StocktakeListRecentResponse>(ipc.IPC_CHANNELS_S5.STOCKTAKE_LIST_RECENT, {}),
    getStocktakeWithLines: (eventId: string) =>
      invoke<ipc.StocktakeGetWithLinesResponse>(ipc.IPC_CHANNELS_S5.STOCKTAKE_GET_WITH_LINES, { eventId }),
    recordCashDrop: (req: ipc.CashDropRecordRequest) =>
      invoke<ipc.CashDropRecordResponse>(ipc.IPC_CHANNELS_S5.CASH_DROP_RECORD, req),
    listCashDrops: (shiftId: string) =>
      invoke<ipc.CashDropListResponse>(ipc.IPC_CHANNELS_S5.CASH_DROP_LIST, { shiftId }),
    getExpectedCash: (shiftId: string) =>
      invoke<ipc.CashDropGetExpectedResponse>(ipc.IPC_CHANNELS_S5.CASH_DROP_GET_EXPECTED, { shiftId }),
    generateDailySummary: (req: ipc.DailySummaryGenerateRequest) =>
      invoke<ipc.DailySummaryGenerateResponse>(ipc.IPC_CHANNELS_S5.DAILY_SUMMARY_GENERATE, req),
    getDailySummary: (req: ipc.DailySummaryGetRequest) =>
      invoke<ipc.DailySummaryGetResponse>(ipc.IPC_CHANNELS_S5.DAILY_SUMMARY_GET, req),
    listDailySummaries: (req: ipc.DailySummaryListRequest = {}) =>
      invoke<ipc.DailySummaryListResponse>(ipc.IPC_CHANNELS_S5.DAILY_SUMMARY_LIST, req),

    // --- Session 6: products + customers admin ---
    adminListProducts: () => invoke<ipc.ProductAdminListResponse>(ipc.IPC_CHANNELS_S6.PRODUCT_ADMIN_LIST, {}),
    addProduct: (req: ipc.ProductAddRequest) => invoke<ipc.ProductAddResponse>(ipc.IPC_CHANNELS_S6.PRODUCT_ADD, req),
    updateProduct: (req: ipc.ProductUpdateRequest) => invoke<ipc.ProductUpdateResponse>(ipc.IPC_CHANNELS_S6.PRODUCT_UPDATE, req),
    deactivateProduct: (productId: string) => invoke<ipc.ProductSimpleResponse>(ipc.IPC_CHANNELS_S6.PRODUCT_DEACTIVATE, { productId }),
    reactivateProduct: (productId: string) => invoke<ipc.ProductSimpleResponse>(ipc.IPC_CHANNELS_S6.PRODUCT_REACTIVATE, { productId }),
    createCustomer: (req: ipc.CustomerCreateRequest) => invoke<ipc.CustomerCreateResponse>(ipc.IPC_CHANNELS_S6.CUSTOMER_CREATE, req),
    updateCustomer: (req: ipc.CustomerUpdateRequest) => invoke<ipc.CustomerSimpleResponse>(ipc.IPC_CHANNELS_S6.CUSTOMER_UPDATE, req),
    blockCustomer: (customerId: string, reason: string) =>
      invoke<ipc.CustomerSimpleResponse>(ipc.IPC_CHANNELS_S6.CUSTOMER_BLOCK, { customerId, reason }),
    unblockCustomer: (customerId: string) => invoke<ipc.CustomerSimpleResponse>(ipc.IPC_CHANNELS_S6.CUSTOMER_UNBLOCK, { customerId }),

    // --- Session 7: pricing tiers + sale relookup ---
    listPricingTiersForProduct: (productId: string) =>
      invoke<ipc.PricingTierListForProductResponse>(ipc.IPC_CHANNELS_S7.PRICING_TIER_LIST_FOR_PRODUCT, { productId }),
    addPricingTier: (req: ipc.PricingTierAddRequest) =>
      invoke<ipc.PricingTierAddResponse>(ipc.IPC_CHANNELS_S7.PRICING_TIER_ADD, req),
    updatePricingTier: (req: ipc.PricingTierUpdateRequest) =>
      invoke<ipc.PricingTierSimpleResponse>(ipc.IPC_CHANNELS_S7.PRICING_TIER_UPDATE, req),
    deactivatePricingTier: (tierId: string) =>
      invoke<ipc.PricingTierSimpleResponse>(ipc.IPC_CHANNELS_S7.PRICING_TIER_DEACTIVATE, { tierId }),
    reactivatePricingTier: (tierId: string) =>
      invoke<ipc.PricingTierSimpleResponse>(ipc.IPC_CHANNELS_S7.PRICING_TIER_REACTIVATE, { tierId }),
    getBestPricingTier: (productId: string, channel: Channel, quantity: number, unitId?: string | null) =>
      invoke<ipc.PricingTierGetBestResponse>(ipc.IPC_CHANNELS_S7.PRICING_TIER_GET_BEST, { productId, channel, quantity, unitId }),
    getSaleLines: (saleId: string) =>
      invoke<ipc.SaleGetLinesResponse>(ipc.IPC_CHANNELS_S7.SALE_GET_LINES, { saleId }),

    // --- Session 8: customer credit + debt tracking ---
    customerOverview: (customerId: string) =>
      invoke<ipc.CustomerOverviewResponse>(ipc.IPC_CHANNELS_S8.CUSTOMER_OVERVIEW, { customerId }),
    customerOpenSales: (customerId: string) =>
      invoke<ipc.CustomerOpenSalesResponse>(ipc.IPC_CHANNELS_S8.CUSTOMER_OPEN_SALES, { customerId }),
    recordCustomerPayment: (req: ipc.CustomerRecordPaymentRequest) =>
      invoke<ipc.CustomerRecordPaymentResponse>(ipc.IPC_CHANNELS_S8.CUSTOMER_RECORD_PAYMENT, req),
    listCustomersByOutstanding: (req: ipc.CustomerListByOutstandingRequest = {}) =>
      invoke<ipc.CustomerListByOutstandingResponse>(ipc.IPC_CHANNELS_S8.CUSTOMER_LIST_BY_OUTSTANDING, req),
    customerAgingSummary: () =>
      invoke<ipc.CustomerAgingSummaryResponse>(ipc.IPC_CHANNELS_S8.CUSTOMER_AGING_SUMMARY, {}),
    reconcileCustomer: (customerId: string) =>
      invoke<ipc.CustomerReconcileResponse>(ipc.IPC_CHANNELS_S8.CUSTOMER_RECONCILE, { customerId }),

    // --- Session 9b: product units UI surface ---
    listProductUnits: (productId: string, activeOnly?: boolean) =>
      invoke<ipc.ProductUnitListResponse>(ipc.IPC_CHANNELS_S9.PRODUCT_UNIT_LIST_FOR_PRODUCT, { productId, activeOnly }),
    addProductUnit: (req: ipc.ProductUnitAddRequest) =>
      invoke<ipc.ProductUnitAddResponse>(ipc.IPC_CHANNELS_S9.PRODUCT_UNIT_ADD, req),
    updateProductUnit: (req: ipc.ProductUnitUpdateRequest) =>
      invoke<ipc.ProductUnitSimpleResponse>(ipc.IPC_CHANNELS_S9.PRODUCT_UNIT_UPDATE, req),
    deactivateProductUnit: (unitId: string) =>
      invoke<ipc.ProductUnitSimpleResponse>(ipc.IPC_CHANNELS_S9.PRODUCT_UNIT_DEACTIVATE, { unitId }),
    reactivateProductUnit: (unitId: string) =>
      invoke<ipc.ProductUnitSimpleResponse>(ipc.IPC_CHANNELS_S9.PRODUCT_UNIT_REACTIVATE, { unitId }),

    // --- Session 11: first-run setup ---
    setupNeedsOwner: () =>
      invoke<ipc.SetupNeedsOwnerResponse>(ipc.IPC_CHANNELS_S11.SETUP_NEEDS_OWNER, {}),
    setupCreateOwner: (req: ipc.SetupCreateOwnerRequest) =>
      invoke<ipc.SetupCreateOwnerResponse>(ipc.IPC_CHANNELS_S11.SETUP_CREATE_OWNER, req),

    // --- Session 11: suppliers admin ---
    listSuppliersForAdmin: () =>
      invoke<ipc.SupplierAdminListResponse>(ipc.IPC_CHANNELS_S11_SUP.SUPPLIER_ADMIN_LIST, {}),
    addSupplier: (req: ipc.SupplierAddRequest) =>
      invoke<ipc.SupplierAddResponse>(ipc.IPC_CHANNELS_S11_SUP.SUPPLIER_ADD, req),
    updateSupplier: (req: ipc.SupplierUpdateRequest) =>
      invoke<ipc.SupplierSimpleResponse>(ipc.IPC_CHANNELS_S11_SUP.SUPPLIER_UPDATE, req),
    deactivateSupplier: (supplierId: string) =>
      invoke<ipc.SupplierSimpleResponse>(ipc.IPC_CHANNELS_S11_SUP.SUPPLIER_DEACTIVATE, { supplierId }),
    reactivateSupplier: (supplierId: string) =>
      invoke<ipc.SupplierSimpleResponse>(ipc.IPC_CHANNELS_S11_SUP.SUPPLIER_REACTIVATE, { supplierId }),

    // --- Session 12: audit log viewer ---
    listAuditEntries: (req: ipc.AuditListRequest) =>
      invoke<ipc.AuditListResponse>(ipc.IPC_CHANNELS_S12_AUDIT.AUDIT_LIST, req),
    listAuditActions: () =>
      invoke<ipc.AuditListActionsResponse>(ipc.IPC_CHANNELS_S12_AUDIT.AUDIT_LIST_ACTIONS, {}),
    listAuditEntityTypes: () =>
      invoke<ipc.AuditListEntityTypesResponse>(ipc.IPC_CHANNELS_S12_AUDIT.AUDIT_LIST_ENTITY_TYPES, {}),

    // --- Session 12: breakage review ---
    reviewBreakage: (req: ipc.BreakageReviewListRequest) =>
      invoke<ipc.BreakageReviewListResponse>(ipc.IPC_CHANNELS_S12_BREAK.BREAKAGE_REVIEW_LIST, req),
    reviewBreakageCauses: () =>
      invoke<ipc.BreakageReviewCausesResponse>(ipc.IPC_CHANNELS_S12_BREAK.BREAKAGE_REVIEW_CAUSES, {}),
    getBreakagePhoto: (relativePath: string) =>
      invoke<ipc.BreakagePhotoResponse>(ipc.IPC_CHANNELS_S12_BREAK.BREAKAGE_PHOTO_DATA, { relativePath }),

    // --- Session 12: pending receipt reprints ---
    listPendingReprints: () =>
      invoke<ipc.ReprintListResponse>(ipc.IPC_CHANNELS_S12_REPRINT.REPRINT_LIST, {}),
    retryReprint: (req: ipc.ReprintRetryRequest) =>
      invoke<ipc.ReprintRetryResponse>(ipc.IPC_CHANNELS_S12_REPRINT.REPRINT_RETRY, req),
    discardReprint: (req: ipc.ReprintDiscardRequest) =>
      invoke<ipc.ReprintSimpleResponse>(ipc.IPC_CHANNELS_S12_REPRINT.REPRINT_DISCARD, req),
    pendingReprintCount: () =>
      invoke<ipc.ReprintPendingCountResponse>(ipc.IPC_CHANNELS_S12_REPRINT.REPRINT_PENDING_COUNT, {}),

    // --- Session 12: stock movement history ---
    stockHistoryForProduct: (productId: string, limit?: number) =>
      invoke<ipc.StockHistoryResponse>(ipc.IPC_CHANNELS_S12_STOCK.STOCK_HISTORY_FOR_PRODUCT, { productId, limit }),

    // --- Session 14: on-demand receipt reprint ---
    reprintSaleReceipt: (saleId: string) =>
      invoke<ipc.SaleReprintResponse>(ipc.IPC_CHANNELS_S14_REPRINT.SALE_REPRINT_RECEIPT, { saleId }),
    getSaleReceipt: (saleId: string) =>
      invoke<ipc.SaleGetReceiptResponse>(ipc.IPC_CHANNELS_S14_REPRINT.SALE_GET_RECEIPT, { saleId }),

    // --- Session 15: period close ---
    periodGetActiveClose: (businessDate: string) =>
      invoke<ipc.PeriodGetActiveCloseResponse>(ipc.IPC_CHANNELS_S15_PERIOD.PERIOD_GET_ACTIVE_CLOSE, { businessDate }),
    periodListCloses: () =>
      invoke<ipc.PeriodListClosesResponse>(ipc.IPC_CHANNELS_S15_PERIOD.PERIOD_LIST_CLOSES, {}),
    periodSeal: (businessDate: string) =>
      invoke<ipc.PeriodSealResponse>(ipc.IPC_CHANNELS_S15_PERIOD.PERIOD_SEAL, { businessDate }),
    periodReopen: (businessDate: string, reason: string) =>
      invoke<ipc.PeriodReopenResponse>(ipc.IPC_CHANNELS_S15_PERIOD.PERIOD_REOPEN, { businessDate, reason }),

    // --- Session 15: exception reports ---
    excVoidsByCashier: (fromDate: string, toDate: string) =>
      invoke<ipc.ExcVoidsByCashierResponse>(ipc.IPC_CHANNELS_S15_EXC.EXC_VOIDS_BY_CASHIER, { fromDate, toDate }),
    excDiscountsByCashier: (fromDate: string, toDate: string) =>
      invoke<ipc.ExcDiscountsByCashierResponse>(ipc.IPC_CHANNELS_S15_EXC.EXC_DISCOUNTS_BY_CASHIER, { fromDate, toDate }),
    excPostSaleEdits: (fromDate: string, toDate: string) =>
      invoke<ipc.ExcPostSaleEditsResponse>(ipc.IPC_CHANNELS_S15_EXC.EXC_POST_SALE_EDITS, { fromDate, toDate }),
    excRepeatedSkuVoids: (fromDate: string, toDate: string) =>
      invoke<ipc.ExcRepeatedSkuVoidsResponse>(ipc.IPC_CHANNELS_S15_EXC.EXC_REPEATED_SKU_VOIDS, { fromDate, toDate }),
    excLargeDiscounts: (fromDate: string, toDate: string) =>
      invoke<ipc.ExcLargeDiscountsResponse>(ipc.IPC_CHANNELS_S15_EXC.EXC_LARGE_DISCOUNTS, { fromDate, toDate }),

    // --- Session 16: reorder PO suggestions ---
    reorderSuggest: (supplierId?: string | null, safetyMultiplier?: number) =>
      invoke<ipc.ReorderSuggestResponse>(ipc.IPC_CHANNELS_S16_REORDER.REORDER_SUGGEST,
        supplierId === undefined ? { safetyMultiplier } : { supplierId, safetyMultiplier }),
    reorderCreateDraftPO: (req: ipc.ReorderCreateDraftPORequest) =>
      invoke<ipc.ReorderCreateDraftPOResponse>(ipc.IPC_CHANNELS_S16_REORDER.REORDER_CREATE_DRAFT_PO, req),
    reorderListDrafts: () =>
      invoke<ipc.ReorderListDraftsResponse>(ipc.IPC_CHANNELS_S16_REORDER.REORDER_LIST_DRAFTS, {}),

    // --- Session 17: petty cash expenses ---
    recordExpense: (req: ipc.ExpenseRecordRequest) =>
      invoke<ipc.ExpenseRecordResponse>(ipc.IPC_CHANNELS_S17_EXPENSES.EXPENSE_RECORD, req),
    listExpensesForShift: (shiftId: string) =>
      invoke<ipc.ExpenseListForShiftResponse>(ipc.IPC_CHANNELS_S17_EXPENSES.EXPENSE_LIST_FOR_SHIFT, { shiftId }),
    expenseTotalsForShift: (shiftId: string) =>
      invoke<ipc.ExpenseTotalsForShiftResponse>(ipc.IPC_CHANNELS_S17_EXPENSES.EXPENSE_TOTALS_FOR_SHIFT, { shiftId }),

    // --- Session 18: OWNER recovery code ---
    recoveryListOwners: () =>
      invoke<ipc.RecoveryListOwnersResponse>(ipc.IPC_CHANNELS_S18_RECOVERY.RECOVERY_LIST_OWNERS, {}),
    recoveryResetPin: (workerId: string, recoveryCode: string, newPin: string) =>
      invoke<ipc.RecoveryResetPinResponse>(ipc.IPC_CHANNELS_S18_RECOVERY.RECOVERY_RESET_PIN, { workerId, recoveryCode, newPin }),
    recoveryRegenerate: () =>
      invoke<ipc.RecoveryRegenerateResponse>(ipc.IPC_CHANNELS_S18_RECOVERY.RECOVERY_REGENERATE, {}),

    // --- Wave B.2: Off-site backup heartbeat ---
    backupGetHeartbeat: () =>
      invoke<ipc.BackupHeartbeat>(ipc.IPC_CHANNELS_BACKUP.BACKUP_GET_HEARTBEAT, {}),
    backupGetConfig: () =>
      invoke<ipc.BackupConfigResponse>(ipc.IPC_CHANNELS_BACKUP.BACKUP_GET_CONFIG, {}),
    backupSetConfig: (targetDir: string, locationClass: ipc.BackupLocationClass) =>
      invoke<ipc.BackupConfigResponse>(ipc.IPC_CHANNELS_BACKUP.BACKUP_SET_CONFIG, { targetDir, locationClass }),
    backupRunNow: () =>
      invoke<ipc.BackupRunNowResponse>(ipc.IPC_CHANNELS_BACKUP.BACKUP_RUN_NOW, {}),
    backupTestTarget: (targetDir?: string) =>
      invoke<ipc.BackupTestTargetResponse>(ipc.IPC_CHANNELS_BACKUP.BACKUP_TEST_TARGET, { targetDir }),
    backupListHistory: () =>
      invoke<ipc.BackupListHistoryResponse>(ipc.IPC_CHANNELS_BACKUP.BACKUP_LIST_HISTORY, {}),
    backupRevealTarget: (path?: string) =>
      invoke<ipc.BackupRevealTargetResponse>(ipc.IPC_CHANNELS_BACKUP.BACKUP_REVEAL_TARGET, { path }),

    // --- Wave C.1: Printable customer statement ---
    customerStatement: (customerId: string, asOfDate?: string, monthsOfHistory?: number) =>
      invoke<ipc.CustomerStatementResponse>(ipc.IPC_CHANNELS_STATEMENT.CUSTOMER_STATEMENT, { customerId, asOfDate, monthsOfHistory }),

    // --- Wave C.2: Per-customer price overrides ---
    cpoListForCustomer: (customerId: string) =>
      invoke<ipc.CpoListResponse>(ipc.IPC_CHANNELS_CPO.CPO_LIST_FOR_CUSTOMER, { customerId }),
    cpoAdd: (req: {
      customerId: string; productId: string; appliesToUnitId: string;
      channel: Channel | null;
      pricePesewas: number; notes?: string | null;
    }) => invoke<ipc.CpoAddResponse>(ipc.IPC_CHANNELS_CPO.CPO_ADD, req),
    cpoUpdate: (id: string, pricePesewas?: number, notes?: string | null) =>
      invoke<ipc.CpoUpdateResponse>(ipc.IPC_CHANNELS_CPO.CPO_UPDATE, { id, pricePesewas, notes }),
    cpoDeactivate: (id: string) =>
      invoke<ipc.CpoDeactivateResponse>(ipc.IPC_CHANNELS_CPO.CPO_DEACTIVATE, { id }),

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
    }) => invoke<ipc.ReturnRecordResponse>(ipc.IPC_CHANNELS_RETURNS.RETURN_RECORD, req),
    listReturnsForCustomer: (customerId: string, limit?: number) =>
      invoke<ipc.ReturnListResponse>(ipc.IPC_CHANNELS_RETURNS.RETURN_LIST_FOR_CUSTOMER, { customerId, limit }),

    // --- Supplier payments ---
    listSupplierPayments: (req: ipc.SupplierPaymentListRequest) =>
      invoke<ipc.SupplierPaymentListResponse>(ipc.IPC_CHANNELS_SUP_PAY.SUPPLIER_PAYMENT_LIST, req),
    recordSupplierPayment: (req: ipc.SupplierPaymentRecordRequest) =>
      invoke<ipc.SupplierPaymentRecordResponse>(ipc.IPC_CHANNELS_SUP_PAY.SUPPLIER_PAYMENT_RECORD, req),
    listSupplierStatements: (req: ipc.SupplierStatementsListRequest) =>
      invoke<ipc.SupplierStatementsListResponse>(ipc.IPC_CHANNELS_SUP_PAY.SUPPLIER_STATEMENTS_LIST, req),

    // --- Reports / dashboard ---
    reportsOverview: (req: ipc.ReportsOverviewRequest = {}) =>
      invoke<ipc.ReportsOverviewResponse>(ipc.IPC_CHANNELS_REPORTS.REPORTS_OVERVIEW, req),
    reportsSales: (req: ipc.ReportsSalesRequest) =>
      invoke<ipc.ReportsSalesResponse>(ipc.IPC_CHANNELS_REPORTS.REPORTS_SALES, req),
    reportsMargin: (req: ipc.ReportsMarginRequest) =>
      invoke<ipc.ReportsMarginResponse>(ipc.IPC_CHANNELS_REPORTS.REPORTS_MARGIN, req),
    reportsInventory: (req: ipc.ReportsInventoryRequest = {}) =>
      invoke<ipc.ReportsInventoryResponse>(ipc.IPC_CHANNELS_REPORTS.REPORTS_INVENTORY, req),

    // --- Catalog data transfer ---
    catalogExport: (req: ipc.CatalogExportRequest = {}) =>
      invoke<ipc.CatalogExportResponse>(ipc.IPC_CHANNELS_CATALOG.CATALOG_EXPORT, req),
    catalogImportPick: () =>
      invoke<ipc.CatalogImportPickResponse>(ipc.IPC_CHANNELS_CATALOG.CATALOG_IMPORT_PICK, {}),
    catalogImportApply: (req: ipc.CatalogImportApplyRequest) =>
      invoke<ipc.CatalogImportApplyResponse>(ipc.IPC_CHANNELS_CATALOG.CATALOG_IMPORT_APPLY, req),

    // --- Receipt customization ---
    receiptGetConfig: () =>
      invoke<ipc.ReceiptConfigResponse>(ipc.IPC_CHANNELS_RECEIPT.RECEIPT_GET_CONFIG, {}),
    receiptSetConfig: (req: ipc.ReceiptSetConfigRequest) =>
      invoke<ipc.ReceiptConfigResponse>(ipc.IPC_CHANNELS_RECEIPT.RECEIPT_SET_CONFIG, req),
  };
}

/** The renderer-facing API shape, derived from the factory. */
export type CounterApi = ReturnType<typeof createCounterApi>;
