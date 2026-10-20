import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChatMarkdown } from '../../src/components/chat-markdown';

it('renders query markdown while keeping HTML, unsafe links and remote images inert', () => {
  const html = renderToStaticMarkup(
    createElement(ChatMarkdown, {
      locale: 'zh',
      text: '## 明细\n\n| 项目 | 金额 |\n| --- | --- |\n| 午餐 | **CNY 35.00** |\n\n- 备注：`肯德基`\n\n[危险链接](javascript:alert(1))\n\n<script>alert(1)</script>\n\n![备注图片](https://example.invalid/private-image.png)',
    })
  );
  expect(html).toContain('<h2>明细</h2>');
  expect(html).toContain('<table>');
  expect(html).toContain('<strong>CNY 35.00</strong>');
  expect(html).toContain('<code>肯德基</code>');
  expect(html).toContain('aria-label="回复中的表格"');
  expect(html).not.toMatch(/<script|javascript:|<img|private-image/);
  expect(html).not.toContain('| --- |');
});
