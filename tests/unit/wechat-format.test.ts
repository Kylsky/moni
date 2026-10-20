import type { ModelMessage } from '@tanstack/ai';
import { describe, expect, it } from 'vitest';
import {
  ledgerQueryResult,
  parseQueryUpdates,
} from '../../src/ledger/chat-query-contract';
import { modelMoney } from '../../src/ledger/model-money';
import { wechatStatistics } from '../../src/lib/wechat-format';

function result() {
  return ledgerQueryResult.parse({
    type: 'ledger_query',
    id: crypto.randomUUID(),
    asOf: Date.UTC(2026, 2, 31, 4),
    query: {
      inheritPrevious: false,
      period: { kind: 'custom', from: '2026-01-01', to: '2026-03-31' },
      scope: 'spending',
      filters: {},
      view: 'summary',
      interval: 'month',
    },
    criteria: { category: null, tags: [] },
    report: {
      datasetId: 'synthetic',
      revision: 1,
      primaryCurrency: 'CNY',
      timeZone: 'Asia/Shanghai',
      filters: { from: '2026-01-01', to: '2026-03-31' },
      groupBy: 'category',
      interval: 'month',
      total: 4,
      counts: { income: 0, expense: 3, refund: 1 },
      totals: { income: 0, expense: 10000, refund: 2500, netExpense: 7500 },
      originalTotals: null,
      groups: [],
      trend: [],
    },
  });
}

describe('shared model money input', () => {
  it('formats draft receipts and refreshed reports without mutating persisted financial results', () => {
    const query = result();
    query.report.totals.netExpense = -1;
    query.report.trend = [
      {
        total: query.report.total,
        counts: query.report.counts,
        totals: query.report.totals,
        originalTotals: null,
        filters: query.report.filters,
        from: '2026-01-01',
        to: '2026-03-31',
      },
    ];
    const failed = crypto.randomUUID();
    const input: ModelMessage = {
      role: 'tool',
      toolCallId: 'synthetic',
      content: JSON.stringify({
        draftId: crypto.randomUUID(),
        status: 'posted',
        version: 1,
        baseCurrency: 'CNY',
        totalBaseMinor: 3500,
        queryUpdates: [
          { id: query.id, result: query },
          { id: failed, result: null },
        ],
      }),
    };
    const before = JSON.stringify(input);
    const shown = JSON.parse(modelMoney(input).content as string);
    expect(shown.totalBaseAmount).toBe('CNY 35.00');
    expect(shown).not.toHaveProperty('totalBaseMinor');
    expect(shown).toMatchObject({ status: 'posted', version: 1 });
    expect(shown.queryUpdates[0].result.report.totals.netExpense).toBe(
      'CNY -0.01'
    );
    expect(shown.queryUpdates[0].result.report.trend[0].totals.netExpense).toBe(
      'CNY -0.01'
    );
    expect(shown.queryUpdates[0].result.report.counts).toEqual(
      query.report.counts
    );
    expect(shown.queryUpdates[1]).toEqual({ id: failed, result: null });
    expect(JSON.stringify(input)).toBe(before);
    const legacy = modelMoney({
      role: 'tool',
      content: JSON.stringify({ queryResult: query }),
    });
    expect(
      JSON.parse(legacy.content as string).queryResult.report.totals.expense
    ).toBe('CNY 100.00');
  });

  it('preserves exact large three-decimal totals and leaves user messages and unrelated tool output intact', () => {
    const shown = modelMoney({
      role: 'tool',
      content: JSON.stringify({
        baseCurrency: 'KWD',
        totalBaseMinor: Number.MAX_SAFE_INTEGER,
      }),
    });
    expect(JSON.parse(shown.content as string).totalBaseAmount).toBe(
      'KWD 9007199254740.991'
    );
    for (const input of [
      { role: 'user', content: JSON.stringify(result()) },
      { role: 'tool', content: '{broken' },
      { role: 'tool', content: JSON.stringify({ count: 3500 }) },
    ] as ModelMessage[])
      expect(modelMoney(input)).toBe(input);
  });
});

describe('WeChat formatted statistics', () => {
  it('shows posted entry names, original and converted amounts, own notes and page hints with literal Markdown escaped', () => {
    const data = result();
    data.query.view = 'entries';
    data.entries = {
      page: 1,
      pageSize: 5,
      pageCount: 2,
      items: [
        {
          id: crypto.randomUUID(),
          name: '*合成午餐*',
          date: '2026-03-01',
          kind: 'expense',
          currency: 'USD',
          originalMinor: 2000,
          baseMinor: 14400,
          categoryName: 'Food',
          categoryKey: 'food',
          tags: ['[外卖]'],
          note: '在肯德基吃的 [菜单](https://example.invalid)',
          noteTruncated: true,
        },
      ],
    };
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('账目明细');
    expect(text).toContain('\\*合成午餐\\*');
    expect(text).toContain('$20.00');
    expect(text).toContain('¥144.00');
    expect(text).toContain('在肯德基吃的');
    expect(text).toContain('备注节选');
    expect(text).toContain('页码 1 / 2');
    expect(text).toContain('下一页');
    expect(text).not.toContain('没有待确认草稿');
    const original = JSON.stringify(data);
    const input: ModelMessage = { role: 'tool', content: original };
    const shown = JSON.parse(modelMoney(input).content as string);
    expect(shown.entries.items[0]).toMatchObject({
      originalAmount: 'USD 20.00',
      baseAmount: 'CNY 144.00',
    });
    expect(shown.entries.items[0]).not.toHaveProperty('baseMinor');
    expect(JSON.stringify(data)).toBe(original);
  });

  it('bounds long detail replies without silently truncating an entry into another page', () => {
    const data = result();
    data.query.view = 'entries';
    data.entries = {
      page: 1,
      pageSize: 5,
      pageCount: 1,
      items: Array.from({ length: 5 }, (_, i) => ({
        id: crypto.randomUUID(),
        name: `合成${i}${'*'.repeat(115)}`,
        date: '2026-03-01',
        kind: 'expense' as const,
        currency: 'CNY' as const,
        originalMinor: 3500,
        baseMinor: 3500,
        categoryName: 'Food',
        categoryKey: 'food',
        tags: ['*'.repeat(30)],
        note: '*'.repeat(200),
        noteTruncated: true,
      })),
    };
    const text = wechatStatistics(data, 'zh');
    expect(text.length).toBeLessThanOrEqual(2300);
    expect(text).toContain('本页部分明细');
    expect(text).not.toContain('下一页');
  });

  it('reads old persisted query results and multi-report refreshes without losing failed report identifiers', () => {
    const query = result();
    const failed = crypto.randomUUID();
    expect(parseQueryUpdates(JSON.stringify(query))).toEqual([
      { id: query.id, result: query },
    ]);
    expect(parseQueryUpdates({ queryResult: query })).toEqual([
      { id: query.id, result: query },
    ]);
    expect(parseQueryUpdates({ queryRefreshError: failed })).toEqual([
      { id: failed, result: null },
    ]);
    const updates = [
      { id: query.id, result: query },
      { id: failed, result: null },
    ];
    expect(
      parseQueryUpdates(JSON.stringify({ queryUpdates: updates }))
    ).toEqual(updates);
  });
  it('rejects corrupt multi-report updates and mismatched report identifiers', () => {
    const query = result();
    for (const raw of [
      '{',
      { queryUpdates: [{ id: crypto.randomUUID(), result: query }] },
      { queryUpdates: [{ id: query.id, result: query, unknown: true }] },
      {
        queryUpdates: Array.from({ length: 13 }, () => ({
          id: query.id,
          result: query,
        })),
      },
      {
        queryUpdates: [
          {
            id: query.id,
            result: { ...query, report: { ...query.report, totals: {} } },
          },
        ],
      },
    ])
      expect(parseQueryUpdates(raw)).toEqual([]);
  });
  it('highlights the exact database total, separates refunds and preserves dates, timezone and accounting basis', () => {
    const text = wechatStatistics(result(), 'zh');
    expect(text).toContain('📊 **账本查询**');
    expect(text).toContain('**净支出：¥75.00**');
    expect(text).toContain('- 支出：**¥100.00**\n- 退款：**¥25.00**');
    expect(text).toContain('- 匹配账目：4');
    expect(text).toContain('2026-01-01 — 2026-03-31');
    expect(text).toContain('Asia/Shanghai · 主币种 CNY');
    expect(text).toContain('退款按自身发生日');
    expect(text).toContain('仅统计当前正式账目');
    expect(text).not.toContain('CNY ¥');
  });

  it('shows income and all-time scope in English without expense-only metrics', () => {
    const data = result();
    data.query.scope = 'income';
    data.report.total = 2;
    data.report.counts = { income: 2, expense: 0, refund: 0 };
    data.query.period = { kind: 'all_time' };
    data.report.totals = {
      income: 12000,
      expense: 0,
      refund: 0,
      netExpense: 0,
    };
    const text = wechatStatistics(data, 'en');
    expect(text).toContain('All time');
    expect(text).toContain('**Income: CN¥120.00**');
    expect(text).not.toContain('- Expense:');
    expect(text).not.toContain('9999');
  });

  it('retains income in an all-scope query without claiming a cash balance', () => {
    const data = result();
    data.query.scope = 'all';
    data.report.totals.income = 5000;
    data.report.total = 5;
    data.report.counts.income = 1;
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('- 收入：**¥50.00**');
    expect(text).toContain('**净支出：¥75.00**');
  });

  it('keeps original-currency totals separate from fixed main-currency totals', () => {
    const data = result();
    data.report.filters.currency = 'USD';
    data.report.originalTotals = {
      income: 0,
      expense: 2000,
      refund: 200,
      netExpense: 1800,
    };
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('**原币合计 · USD**');
    expect(text).toContain('- 净支出：**US$18.00**');
    expect(text).toContain('- 退款：**US$2.00**');
    expect(text).toContain('**净支出：¥75.00**');
  });

  it('does not present no matching records as zero actual spending', () => {
    const data = result();
    data.report.total = 0;
    data.report.counts = { income: 0, expense: 0, refund: 0 };
    data.report.totals = { income: 0, expense: 0, refund: 0, netExpense: 0 };
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('未找到匹配记录，不代表没有发生实际消费');
    expect(text).not.toContain('**净支出');
    expect(text).not.toContain('¥0.00');
  });

  it('shows requested category groups and escapes user-controlled labels', () => {
    const data = result();
    data.query.view = 'categories';
    data.report.groups = [
      {
        id: 'synthetic-category',
        name: '**Promo**',
        categoryKey: null,
        kind: 'expense',
        total: 4,
        counts: data.report.counts,
        totals: data.report.totals,
        originalTotals: null,
        filters: data.report.filters,
      },
    ];
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('📊 **按类目统计**');
    expect(text).toContain(String.raw`**\*\*Promo\*\* · ¥75.00**`);
    expect(text).not.toContain('**Promo**');
  });

  it('warns that tag groups overlap and preserves the independent overall total', () => {
    const data = result();
    data.query.view = 'tags';
    data.report.groupBy = 'tag';
    data.report.groups = ['外卖', '午餐'].map((name, index) => ({
      id: String(index),
      name,
      categoryKey: null,
      kind: null,
      total: 4,
      counts: data.report.counts,
      totals: data.report.totals,
      originalTotals: null,
      filters: data.report.filters,
    }));
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('**外卖 · ¥75.00**');
    expect(text).toContain('**午餐 · ¥75.00**');
    expect(text).toContain('分组金额不能相加作为总额');
    expect(text).toContain('**净支出：¥75.00**');
    expect(text).not.toContain('¥150.00');
  });

  it('keeps negative net spending and refund-only periods visible in chronological trend rows', () => {
    const data = result();
    data.query.view = 'trend';
    data.report.trend = [
      {
        from: '2026-01-01',
        to: '2026-01-31',
        total: 3,
        counts: { income: 0, expense: 3, refund: 0 },
        totals: { income: 0, expense: 10000, refund: 0, netExpense: 10000 },
        originalTotals: null,
        filters: data.report.filters,
      },
      {
        from: '2026-02-01',
        to: '2026-02-28',
        total: 1,
        counts: { income: 0, expense: 0, refund: 1 },
        totals: { income: 0, expense: 0, refund: 2500, netExpense: -2500 },
        originalTotals: null,
        filters: data.report.filters,
      },
    ];
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('**2026-02-01 — 2026-02-28 · -¥25.00**');
    expect(text.indexOf('**2026-01-01 —')).toBeLessThan(
      text.indexOf('**2026-02-01 —')
    );
  });

  it('keeps complete group blocks within the reply budget and explicitly marks partial detail', () => {
    const data = result();
    data.query.view = 'categories';
    data.report.total = 50;
    data.report.counts = { income: 0, expense: 50, refund: 0 };
    data.report.totals = {
      income: 0,
      expense: 10000,
      refund: 0,
      netExpense: 10000,
    };
    data.report.groups = Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      name: `合成类目${index}`,
      categoryKey: null,
      kind: 'expense' as const,
      total: 1,
      counts: { income: 0, expense: 1, refund: 0 },
      totals: { income: 0, expense: 200, refund: 0, netExpense: 200 },
      originalTotals: null,
      filters: data.report.filters,
    }));
    const text = wechatStatistics(data, 'zh');
    expect(text.length).toBeLessThan(2600);
    expect(text).toContain('**净支出：¥100.00**');
    expect(text).toContain('仅展示部分分组或时段');
    expect(text).toContain('查询于');
    expect(text).not.toContain('合成类目49');
  });

  it('shows a clear fallback for oversized conditions rather than silently dropping filters', () => {
    const data = result();
    data.criteria.tags = Array.from({ length: 20 }, () => ({
      id: crypto.randomUUID(),
      name: '*'.repeat(100),
    }));
    data.report.filters.requiredTagIds = data.criteria.tags.map(
      (tag) => tag.id
    );
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('请到 Moni 网页查看完整统计');
    expect(text).not.toContain('**净支出');
    expect(text.length).toBeLessThan(2600);
  });

  it('retains the most recent periods in chronological order when a long trend is shortened', () => {
    const data = result();
    data.query.view = 'trend';
    const range = { from: '2024-01-01', to: '2025-12-31' };
    data.query.period = { kind: 'custom', ...range };
    data.report.filters = { ...data.report.filters, ...range };
    data.report.total = 24;
    data.report.counts = { income: 0, expense: 24, refund: 0 };
    data.report.totals = {
      income: 0,
      expense: 2400,
      refund: 0,
      netExpense: 2400,
    };
    data.report.trend = Array.from({ length: 24 }, (_, index) => ({
      from: new Date(Date.UTC(2024, index, 1)).toISOString().slice(0, 10),
      to: new Date(Date.UTC(2024, index + 1, 0)).toISOString().slice(0, 10),
      total: 1,
      counts: { income: 0, expense: 1, refund: 0 },
      totals: { income: 0, expense: 100, refund: 0, netExpense: 100 },
      originalTotals: null,
      filters: data.report.filters,
    }));
    const text = wechatStatistics(data, 'zh');
    expect(text).toContain('**2025-12-01 — 2025-12-31 · ¥1.00**');
    expect(text).not.toContain('**2024-01-01');
    expect(text).toContain('仅展示部分分组或时段');
    expect(text.length).toBeLessThan(2600);
    const dates = [...text.matchAll(/\*\*(\d{4}-\d{2}-\d{2}) —/g)].map(
      (match) => match[1]
    );
    expect(dates).toEqual([...dates].sort());
  });
});
