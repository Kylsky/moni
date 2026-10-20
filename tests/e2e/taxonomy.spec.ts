import { expect, test } from '@playwright/test';
import { startTestServer } from '../../scripts/local-test-server.mjs';

let fixture: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  fixture = await startTestServer();
});
test.afterAll(async () => {
  await fixture?.close();
});

test('category names reach forms and details; tag merge deduplicates actual entry links', async ({
  page,
  request,
  isMobile,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const command = () => ({
    datasetId: 'initial',
    operationId: crypto.randomUUID(),
  });
  expect(
    (
      await request.post(`${fixture.url}/api/initialize`, {
        data: {
          ...command(),
          primaryCurrency: 'CNY',
          timeZone: 'Asia/Shanghai',
        },
      })
    ).status()
  ).toBe(200);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, tags] of [
    ['takeout', 'delivery'],
    ['takeout'],
  ].entries()) {
    expect(
      (
        await request.post(`${fixture.url}/api/entries`, {
          data: {
            ...command(),
            id: ids[index],
            name: `Synthetic ${index}`,
            kind: 'expense',
            amount: '35',
            tags,
            note: 'Synthetic note',
          },
        })
      ).status()
    ).toBe(200);
  }
  await page.goto(`${fixture.url}/?view=settings`);
  await page
    .getByRole('link', { name: 'Categories & tags', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add category', exact: true }).click();
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Add category', exact: true })
  ).toBeFocused();
  await page.getByRole('button', { name: 'Add category', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic travel');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await (await request.get(`${fixture.url}/api/taxonomy`)).json();
  const category = state.categories.find(
    (item: { name: string }) => item.name === 'Synthetic travel'
  );
  expect(category.kind).toBe('expense');
  const before = (
    await (await request.get(`${fixture.url}/api/entries`)).json()
  ).find((entry: { id: string }) => entry.id === ids[0]);
  expect(
    (
      await request.put(`${fixture.url}/api/entries`, {
        data: {
          ...command(),
          id: ids[0],
          version: before.version,
          kind: 'expense',
          name: 'Synthetic 0',
          amount: '35',
          categoryId: category.id,
          tags: ['takeout', 'delivery'],
          note: 'Synthetic note',
        },
      })
    ).status()
  ).toBe(200);
  await page
    .getByRole('button', {
      name: 'Rename category Synthetic travel',
      exact: true,
    })
    .click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic trips');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: 'Rename category Synthetic trips',
      exact: true,
    })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Income', exact: true }).click();
  await expect(page.getByText('Synthetic trips', { exact: true })).toHaveCount(
    0
  );
  await page.getByRole('button', { name: 'Expense', exact: true }).click();
  if (isMobile)
    await page.getByRole('button', { name: 'Tags', exact: true }).click();
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic empty');
  await page.route('**/api/tags', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"synthetic_failure"}',
    })
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('input is preserved');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Synthetic empty'
  );
  await page.unroute('**/api/tags');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('checkbox', { name: /takeout/ }).check();
  await page.getByRole('checkbox', { name: /delivery/ }).check();
  await page
    .getByLabel('Keep this tag', { exact: true })
    .selectOption({ label: 'delivery' });
  await expect(page.getByText('Merge selected tags into:')).toContainText(
    'delivery'
  );
  await page
    .getByRole('button', { name: 'Confirm merge', exact: true })
    .click();
  await expect(page.getByRole('checkbox', { name: /takeout/ })).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: /delivery 2 entries/ })
  ).toBeVisible();
  const merged = await (await request.get(`${fixture.url}/api/entries`)).json();
  expect(
    merged.map((entry: { tags: { name: string }[] }) =>
      entry.tags.map((tag) => tag.name)
    )
  ).toEqual([['delivery'], ['delivery']]);
  await page
    .getByRole('link', { name: 'Settings', exact: true })
    .first()
    .click();
  await page.locator('[data-slot="theme-switcher-trigger"]').click();
  await page.locator('[data-theme-option="dark"]').click();
  await page.getByLabel('Language', { exact: true }).selectOption('zh');
  await page.getByRole('link', { name: '分类与标签', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: '重命名类目 Synthetic trips',
      exact: true,
    })
  ).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.goto(`${fixture.url}/?view=entries&entry=${ids[0]}`);
  await expect(
    page.getByText('Synthetic trips', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('Synthetic note', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '修改账目', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: '类目', exact: true })
  ).toContainText('Synthetic trips');
  await expect(page.getByLabel('标签', { exact: true })).toHaveValue(
    'delivery'
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  expect(errors).toEqual([]);
});
