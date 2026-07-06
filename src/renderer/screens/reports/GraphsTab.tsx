import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { counter } from '../../lib/ipc';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { ReportsGraphsResponse } from '../../../shared/types/ipc';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { FeedbackBanner } from '../../components/FeedbackBanner';

const COLORS = {
  revenue: '#7c3aed',
  profit: '#16a34a',
  tax: '#f97316',
  expenses: '#dc2626',
  drawings: '#0891b2',
  sales: '#64748b',
  stock: '#0d9488',
  credit: '#be123c',
  supplier: '#9333ea',
  amber: '#d97706',
};

const CATEGORY_COLORS = ['#7c3aed', '#16a34a', '#f97316', '#0891b2', '#dc2626', '#64748b', '#d97706', '#0d9488'];

type GraphRow = ReportsGraphsResponse['series'][number] & {
  label: string;
  revenue: number;
  profit: number;
  tax: number;
  expenses: number;
  drawings: number;
};

function toCedis(pesewas: number): number {
  return Math.round(pesewas) / 100;
}

function cedisAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `GHS ${(value / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `GHS ${value.toFixed(0)}`;
}

function cedisTooltip(value: unknown, name: unknown): [string, string] {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return [formatMoneyWithCurrency(Math.round(n * 100)), String(name)];
}

function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${month}/${day}`;
}

function labelize(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function GraphsTab() {
  const [range, setRange] = useState<DateRange>(defaultDateRange());
  const [data, setData] = useState<ReportsGraphsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await counter.reportsGraphs({ fromDate: range.fromDate, toDate: range.toDate });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data);
    setError(null);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range.fromDate, range.toDate]);

  const rows: GraphRow[] = useMemo(() => (data?.series ?? []).map((r) => ({
    ...r,
    label: shortDate(r.date),
    revenue: toCedis(r.revenuePesewas),
    profit: toCedis(r.netProfitPesewas),
    tax: toCedis(r.taxPayablePesewas),
    expenses: toCedis(r.expensesPesewas),
    drawings: toCedis(r.drawingsPesewas),
  })), [data]);
  const topProducts = useMemo(() => (data?.topProductsByProfit ?? []).map((r) => ({
    ...r,
    shortName: r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name,
    revenue: toCedis(r.revenuePesewas),
    profit: toCedis(r.grossProfitPesewas),
  })), [data]);
  const categoryProfit = useMemo(() => (data?.categoryProfit ?? []).map((r) => ({
    ...r,
    categoryLabel: labelize(r.category),
    revenue: toCedis(r.revenuePesewas),
    profit: toCedis(r.grossProfitPesewas),
  })), [data]);
  const slowStock = useMemo(() => (data?.slowStock ?? []).map((r) => ({
    ...r,
    shortName: r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name,
    stockValue: toCedis(r.stockValuePesewas),
  })), [data]);
  const customerValue = useMemo(() => (data?.customerValue ?? []).map((r) => ({
    ...r,
    shortName: r.name.length > 20 ? `${r.name.slice(0, 19)}…` : r.name,
    revenue: toCedis(r.revenuePesewas),
  })), [data]);
  const creditAging = useMemo(() => (data?.creditAging ?? []).map((r) => ({
    ...r,
    amount: toCedis(r.amountPesewas),
  })), [data]);
  const expensesByCategory = useMemo(() => (data?.expensesByCategory ?? []).map((r) => ({
    ...r,
    categoryLabel: labelize(r.category),
    amount: toCedis(r.amountPesewas),
  })), [data]);
  const drawingsByCategory = useMemo(() => (data?.drawingsByCategory ?? []).map((r) => ({
    ...r,
    categoryLabel: labelize(r.category),
    amount: toCedis(r.amountPesewas),
  })), [data]);
  const moneyOut = useMemo(() => (data?.moneyOut ?? []).map((r) => ({
    ...r,
    amount: toCedis(r.amountPesewas),
  })), [data]);
  const stockoutForecast = useMemo(() => (data?.stockoutForecast ?? []).map((r) => ({
    ...r,
    shortName: r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name,
    cover: r.daysCover ?? 0,
    stockValue: toCedis(r.stockValuePesewas),
  })), [data]);
  const cashVarianceByWorker = useMemo(() => (data?.cashVarianceByWorker ?? []).map((r) => ({
    ...r,
    shortName: r.workerName.length > 20 ? `${r.workerName.slice(0, 19)}…` : r.workerName,
    netVariance: toCedis(r.netVariancePesewas),
    totalAbsoluteVariance: toCedis(r.totalAbsoluteVariancePesewas),
    avgAbsoluteVariance: toCedis(r.avgAbsoluteVariancePesewas),
  })), [data]);
  const deliveryByDay = useMemo(() => (data?.deliveryByDay ?? []).map((r) => ({
    ...r,
    label: shortDate(r.date),
    fee: toCedis(r.deliveryFeePesewas),
    cost: toCedis(r.deliveryCostPesewas),
    profit: toCedis(r.deliveryProfitPesewas),
  })), [data]);
  const deliveryByDriver = useMemo(() => (data?.deliveryByDriver ?? []).map((r) => ({
    ...r,
    shortName: r.driverName.length > 20 ? `${r.driverName.slice(0, 19)}…` : r.driverName,
    fee: toCedis(r.deliveryFeePesewas),
    cost: toCedis(r.deliveryCostPesewas),
    profit: toCedis(r.deliveryProfitPesewas),
  })), [data]);

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-bg-surface border border-border p-4 flex items-end justify-between gap-3 flex-wrap">
        <DateRangePicker value={range} onChange={setRange} />
        <button onClick={() => void load()}
          className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {loading && !data && <div className="text-text-tertiary text-sm">Loading...</div>}

      {data && (
        <>
          <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <Stat label="Revenue" value={formatMoneyWithCurrency(data.totals.revenuePesewas)} />
            <Stat label="Net profit" value={formatMoneyWithCurrency(data.totals.netProfitPesewas)}
              tone={data.totals.netProfitPesewas < 0 ? 'danger' : 'success'} />
            <Stat label="Tax to pay" value={formatMoneyWithCurrency(data.totals.taxPayablePesewas)} tone="warning" />
            <Stat label="Credit open" value={formatMoneyWithCurrency(data.totals.creditOutstandingPesewas)} tone={data.totals.creditOutstandingPesewas > 0 ? 'danger' : undefined} />
            <Stat label="Stock at cost" value={formatMoneyWithCurrency(data.totals.stockAtCostPesewas)} />
            <Stat label="Supplier paid" value={formatMoneyWithCurrency(data.totals.supplierPaymentsPesewas)} />
          </section>

          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Expenses" value={formatMoneyWithCurrency(data.totals.expensesPesewas)} />
            <Stat label="Drawings" value={formatMoneyWithCurrency(data.totals.drawingsPesewas)} />
            <Stat label="Tax paid" value={formatMoneyWithCurrency(data.totals.taxPaidPesewas)} />
            <Stat label="Sales" value={String(data.totals.numSales)} />
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <ChartCard title="Revenue vs net profit">
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={rows} margin={{ top: 16, right: 20, bottom: 8, left: 8 }}>
                  <defs>
                    <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.revenue} stopOpacity={0.26} />
                      <stop offset="95%" stopColor={COLORS.revenue} stopOpacity={0.03} />
                    </linearGradient>
                    <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.profit} stopOpacity={0.24} />
                      <stop offset="95%" stopColor={COLORS.profit} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d9dce6' }} />
                  <YAxis tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} width={74} />
                  <Tooltip formatter={cedisTooltip} labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''} contentStyle={tooltipStyle} />
                  <Legend iconType="circle" wrapperStyle={{ color: '#6b7280', fontSize: 12 }} />
                  <Area type="monotone" dataKey="revenue" name="Revenue" stroke={COLORS.revenue} fill="url(#revenueFill)" strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                  <Area type="monotone" dataKey="profit" name="Net profit" stroke={COLORS.profit} fill="url(#profitFill)" strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                  <ReferenceLine y={0} stroke="#9ca3af" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Money leaving the business">
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={rows} margin={{ top: 16, right: 20, bottom: 8, left: 8 }}>
                  <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d9dce6' }} />
                  <YAxis tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} width={74} />
                  <Tooltip formatter={cedisTooltip} labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''} contentStyle={tooltipStyle} />
                  <Legend iconType="circle" wrapperStyle={{ color: '#6b7280', fontSize: 12 }} />
                  <Line type="monotone" dataKey="tax" name="Tax to pay" stroke={COLORS.tax} strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                  <Line type="monotone" dataKey="expenses" name="Expenses" stroke={COLORS.expenses} strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                  <Line type="monotone" dataKey="drawings" name="Drawings" stroke={COLORS.drawings} strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                  <ReferenceLine y={0} stroke="#9ca3af" />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <ChartCard title="Stockout forecast">
              {stockoutForecast.length > 0 ? (
                <ResponsiveContainer width="100%" height={360}>
                  <BarChart data={stockoutForecast} layout="vertical" margin={{ top: 12, right: 24, bottom: 8, left: 84 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis dataKey="shortName" type="category" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip
                      formatter={(value, name) => [String(value), String(name)]}
                      contentStyle={tooltipStyle}
                    />
                    <Bar dataKey="cover" name="Days cover" fill={COLORS.amber} radius={[0, 4, 4, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>

            <ChartCard title="Cash variance by cashier">
              {cashVarianceByWorker.length > 0 ? (
                <ResponsiveContainer width="100%" height={360}>
                  <BarChart data={cashVarianceByWorker} layout="vertical" margin={{ top: 12, right: 24, bottom: 8, left: 84 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" horizontal={false} />
                    <XAxis type="number" tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis dataKey="shortName" type="category" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip formatter={cedisTooltip} contentStyle={tooltipStyle} />
                    <Legend iconType="circle" wrapperStyle={{ color: '#6b7280', fontSize: 12 }} />
                    <Bar dataKey="totalAbsoluteVariance" name="Total variance" fill={COLORS.credit} radius={[0, 4, 4, 0]} maxBarSize={18} />
                    <Bar dataKey="avgAbsoluteVariance" name="Avg variance" fill={COLORS.sales} radius={[0, 4, 4, 0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <ChartCard title="Delivery profit by day">
              {deliveryByDay.length > 0 ? (
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={deliveryByDay} margin={{ top: 16, right: 20, bottom: 8, left: 8 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d9dce6' }} />
                    <YAxis tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} width={74} />
                    <Tooltip formatter={cedisTooltip} labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''} contentStyle={tooltipStyle} />
                    <Legend iconType="circle" wrapperStyle={{ color: '#6b7280', fontSize: 12 }} />
                    <Line type="monotone" dataKey="fee" name="Fees" stroke={COLORS.drawings} strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="cost" name="Costs" stroke={COLORS.expenses} strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="profit" name="Profit" stroke={COLORS.profit} strokeWidth={3} dot={false} activeDot={{ r: 5 }} />
                    <ReferenceLine y={0} stroke="#9ca3af" />
                  </LineChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>

            <ChartCard title="Delivery profit by driver">
              {deliveryByDriver.length > 0 ? (
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={deliveryByDriver} layout="vertical" margin={{ top: 12, right: 24, bottom: 8, left: 84 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" horizontal={false} />
                    <XAxis type="number" tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis dataKey="shortName" type="category" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip formatter={cedisTooltip} contentStyle={tooltipStyle} />
                    <Bar dataKey="profit" name="Delivery profit" fill={COLORS.profit} radius={[0, 4, 4, 0]} maxBarSize={20} />
                    <ReferenceLine x={0} stroke="#9ca3af" />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <ChartCard title="Top products by profit">
              {topProducts.length > 0 ? (
                <ResponsiveContainer width="100%" height={360}>
                  <BarChart data={topProducts} layout="vertical" margin={{ top: 12, right: 24, bottom: 8, left: 84 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" horizontal={false} />
                    <XAxis type="number" tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis dataKey="shortName" type="category" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip formatter={cedisTooltip} contentStyle={tooltipStyle} />
                    <Legend iconType="circle" wrapperStyle={{ color: '#6b7280', fontSize: 12 }} />
                    <Bar dataKey="profit" name="Gross profit" fill={COLORS.profit} radius={[0, 4, 4, 0]} maxBarSize={18} />
                    <Bar dataKey="revenue" name="Revenue" fill={COLORS.revenue} radius={[0, 4, 4, 0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>

            <ChartCard title="Category revenue and profit">
              {categoryProfit.length > 0 ? (
                <ResponsiveContainer width="100%" height={360}>
                  <BarChart data={categoryProfit} margin={{ top: 16, right: 20, bottom: 8, left: 8 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="categoryLabel" tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d9dce6' }} />
                    <YAxis tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} width={74} />
                    <Tooltip formatter={cedisTooltip} contentStyle={tooltipStyle} />
                    <Legend iconType="circle" wrapperStyle={{ color: '#6b7280', fontSize: 12 }} />
                    <Bar dataKey="revenue" name="Revenue" fill={COLORS.revenue} radius={[4, 4, 0, 0]} maxBarSize={34} />
                    <Bar dataKey="profit" name="Gross profit" fill={COLORS.profit} radius={[4, 4, 0, 0]} maxBarSize={34} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <ChartCard title="Slow stock value">
              {slowStock.length > 0 ? (
                <ResponsiveContainer width="100%" height={360}>
                  <BarChart data={slowStock} layout="vertical" margin={{ top: 12, right: 24, bottom: 8, left: 84 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" horizontal={false} />
                    <XAxis type="number" tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis dataKey="shortName" type="category" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip formatter={cedisTooltip} contentStyle={tooltipStyle} />
                    <Bar dataKey="stockValue" name="Stock value" fill={COLORS.stock} radius={[0, 4, 4, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>

            <ChartCard title="Customer value">
              {customerValue.length > 0 ? (
                <ResponsiveContainer width="100%" height={360}>
                  <BarChart data={customerValue} layout="vertical" margin={{ top: 12, right: 24, bottom: 8, left: 84 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" horizontal={false} />
                    <XAxis type="number" tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis dataKey="shortName" type="category" tick={{ fill: '#6b7280', fontSize: 12 }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip formatter={cedisTooltip} contentStyle={tooltipStyle} />
                    <Bar dataKey="revenue" name="Revenue" fill={COLORS.supplier} radius={[0, 4, 4, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <ChartCard title="Credit aging">
              {creditAging.length > 0 ? (
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={creditAging} margin={{ top: 16, right: 20, bottom: 8, left: 8 }}>
                    <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="bucket" tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d9dce6' }} />
                    <YAxis tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} width={74} />
                    <Tooltip formatter={cedisTooltip} contentStyle={tooltipStyle} />
                    <Bar dataKey="amount" name="Outstanding" fill={COLORS.credit} radius={[4, 4, 0, 0]} maxBarSize={44} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>

            <ChartCard title="Money leaving mix">
              {moneyOut.length > 0 ? (
                <ResponsiveContainer width="100%" height={320}>
                  <PieChart>
                    <Tooltip formatter={cedisTooltip} contentStyle={tooltipStyle} />
                    <Legend iconType="circle" wrapperStyle={{ color: '#6b7280', fontSize: 12 }} />
                    <Pie data={moneyOut} dataKey="amount" nameKey="kind" innerRadius={68} outerRadius={112} paddingAngle={2}>
                      {moneyOut.map((_, idx) => (
                        <Cell key={idx} fill={CATEGORY_COLORS[idx % CATEGORY_COLORS.length]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyChart />}
            </ChartCard>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <ChartCard title="Daily tax payable">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={rows} margin={{ top: 16, right: 20, bottom: 8, left: 8 }}>
                  <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d9dce6' }} />
                  <YAxis tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} width={74} />
                  <Tooltip formatter={cedisTooltip} labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''} contentStyle={tooltipStyle} />
                  <Bar dataKey="tax" name="Tax to pay" fill={COLORS.tax} radius={[4, 4, 0, 0]} maxBarSize={42} />
                  <ReferenceLine y={0} stroke="#9ca3af" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Expenses and drawings">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={rows} margin={{ top: 16, right: 20, bottom: 8, left: 8 }}>
                  <CartesianGrid stroke="#d9dce6" strokeDasharray="4 4" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d9dce6' }} />
                  <YAxis tickFormatter={cedisAxis} tick={{ fill: '#8b8f9f', fontSize: 12 }} tickLine={false} axisLine={false} width={74} />
                  <Tooltip formatter={cedisTooltip} labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''} contentStyle={tooltipStyle} />
                  <Legend iconType="circle" wrapperStyle={{ color: '#6b7280', fontSize: 12 }} />
                  <Bar dataKey="expenses" name="Expenses" fill={COLORS.expenses} radius={[4, 4, 0, 0]} maxBarSize={36} />
                  <Bar dataKey="drawings" name="Drawings" fill={COLORS.drawings} radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <BreakdownTable
              title="Expenses by category"
              rows={expensesByCategory.map((row) => ({
                label: row.categoryLabel,
                value: formatMoneyWithCurrency(row.amountPesewas),
              }))}
            />
            <BreakdownTable
              title="Drawings by category"
              rows={drawingsByCategory.map((row) => ({
                label: row.categoryLabel,
                value: formatMoneyWithCurrency(row.amountPesewas),
              }))}
            />
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <BreakdownTable
              title="Stockout watchlist"
              rows={stockoutForecast.map((row) => ({
                label: row.name,
                value: row.daysCover == null ? 'No recent sales' : `${row.daysCover.toFixed(1)} days`,
              }))}
            />
            <BreakdownTable
              title="Delivery outcomes"
              rows={deliveryByDriver.map((row) => ({
                label: row.driverName,
                value: `${row.deliveredCount} delivered · ${row.failedCount} failed · ${formatMoneyWithCurrency(row.deliveryProfitPesewas)}`,
              }))}
            />
          </section>
        </>
      )}
    </div>
  );
}

const tooltipStyle = {
  background: '#ffffff',
  border: '1px solid #d9dce6',
  borderRadius: 4,
  color: '#111827',
  fontSize: 12,
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' | 'danger' }) {
  const color = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : '';
  return (
    <div className="bg-bg-surface border border-border p-4">
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className={`font-mono tnum text-lg mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-bg-surface border border-border p-4 min-h-[380px]">
      <h3 className="text-text-secondary uppercase tracking-wider text-xs mb-3">{title}</h3>
      {children}
    </section>
  );
}

function EmptyChart() {
  return (
    <div className="h-[280px] flex items-center justify-center text-text-tertiary text-sm">
      No data in this period.
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: Array<{ label: string; value: string }> }) {
  return (
    <section className="bg-bg-surface border border-border">
      <div className="px-4 py-3 border-b border-border-subtle">
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
      </div>
      <div className="divide-y divide-border-subtle">
        {rows.length > 0 ? rows.map((row) => (
          <div key={row.label} className="px-4 py-3 flex items-center justify-between gap-4 text-sm">
            <span className="text-text-secondary">{row.label}</span>
            <span className="font-mono tnum text-text-primary">{row.value}</span>
          </div>
        )) : (
          <div className="px-4 py-6 text-center text-text-tertiary text-sm">No data in this period.</div>
        )}
      </div>
    </section>
  );
}
