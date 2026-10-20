import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

test('the complete chat composer stays inside short desktop and mobile viewports', async ({
  page,
  request,
  isMobile,
}) => {
  const fixture = await startTestServer();
  try {
    expect(
      (
        await request.post(`${fixture.url}/api/initialize`, {
          data: {
            datasetId: 'initial',
            operationId: crypto.randomUUID(),
            primaryCurrency: 'CNY',
            timeZone: 'Asia/Shanghai',
          },
        })
      ).status()
    ).toBe(200);
    const db = await fixture.runtime.getD1Database('DB');
    const id = crypto.randomUUID();
    await db.batch(
      Array.from({ length: 8 }, (_, index) =>
        db
          .prepare(
            "INSERT INTO conversations(dataset_id,id,title,created_at,updated_at) VALUES('initial',?,?,?,?)"
          )
          .bind(
            index ? crypto.randomUUID() : id,
            `Synthetic recent ${index}`,
            1000 + index,
            1000 + index
          )
      )
    );
    const history = Array.from({ length: 50 }, (_, index) => ({
      id: `layout-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `Synthetic message ${index} ${'Saved ledger context. '.repeat(10)}`,
    }));
    await db
      .prepare(
        "INSERT INTO chat_messages(dataset_id,thread_id,position,message_json) SELECT 'initial',?,CAST(key AS INTEGER),value FROM json_each(?)"
      )
      .bind(id, JSON.stringify(history))
      .run();
    const sizes = isMobile
      ? [
          { width: 390, height: 844 },
          { width: 320, height: 700 },
        ]
      : [
          { width: 1440, height: 580 },
          { width: 1024, height: 500 },
          { width: 1440, height: 300 },
        ];
    for (const thread of ['', id]) {
      for (const size of sizes) {
        await page.setViewportSize(size);
        await page.goto(
          `${fixture.url}/?view=chat${thread ? `&thread=${thread}` : ''}`
        );
        if (thread)
          await expect(
            page
              .getByRole('listitem')
              .filter({ hasText: 'Synthetic message 49' })
          ).toBeVisible();
        if (!isMobile)
          await expect(
            page.getByRole('link', { name: 'All conversations', exact: true })
          ).toBeVisible();
        const input = page.getByLabel('Add an entry, or ask your ledger…', {
          exact: true,
        });
        const composer = page.locator('form').filter({ has: input });
        await expect(input).toBeVisible();
        await expect(composer).toBeInViewport({ ratio: 1 });
        await expect(
          page.getByRole('button', { name: 'Send message', exact: true })
        ).toBeInViewport({ ratio: 1 });
        expect(
          await input.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const navigation = document.querySelector(
              'nav[aria-label="Main navigation"]'
            );
            const navRect = navigation?.getBoundingClientRect();
            return (
              rect.bottom <=
              (navRect &&
              getComputedStyle(navigation as Element).position === 'fixed'
                ? navRect.top
                : innerHeight)
            );
          })
        ).toBe(true);
      }
    }
  } finally {
    await fixture.close();
  }
});

test('the chat composer stays above the bottom of a zoomed visual viewport', async ({
  page,
  request,
  isMobile,
}) => {
  const fixture = await startTestServer();
  try {
    await request.post(`${fixture.url}/api/initialize`, {
      data: {
        datasetId: 'initial',
        operationId: crypto.randomUUID(),
        primaryCurrency: 'CNY',
        timeZone: 'Asia/Shanghai',
      },
    });
    await page.setViewportSize({ width: isMobile ? 390 : 1440, height: 700 });
    await page.goto(`${fixture.url}/?view=chat`);
    const input = page.getByLabel('Add an entry, or ask your ledger…', {
      exact: true,
    });
    await expect(input).toBeEnabled();
    const session = await page.context().newCDPSession(page);
    for (const scale of [1.25, 1.5, 1]) {
      await session.send('Emulation.setPageScaleFactor', {
        pageScaleFactor: scale,
      });
      await expect
        .poll(() =>
          input.evaluate((node) => {
            const viewport = window.visualViewport;
            return (
              (node.closest('form')?.getBoundingClientRect().bottom ??
                Infinity) <=
              (viewport ? viewport.height + viewport.offsetTop : innerHeight) +
                1
            );
          })
        )
        .toBe(true);
    }
  } finally {
    await fixture.close();
  }
});
