import { expect, it } from 'vitest';
import { restrictedPage } from '@/lib/restricted-page';

it('distinguishes unavailable setup from denied identity without exposing configuration or private navigation', async () => {
  for (const [language, setup, denied] of [
    ['zh-CN', '配置未完成', '访问受限'],
    ['en', 'Setup incomplete', 'Access restricted'],
  ]) {
    for (const [status, title] of [
      [503, setup],
      [403, denied],
    ] as const) {
      const response = restrictedPage(
        new Request('https://moni.invalid/', {
          headers: { 'Accept-Language': language },
        }),
        status
      );
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(response.headers.get('X-Robots-Tag')).toContain('noindex');
      const html = await response.text();
      expect(html).toContain(`<h1>${title}</h1>`);
      expect(html).not.toContain('<nav');
      expect(html).not.toContain('<input');
      expect(html).not.toContain('OWNER_SUBJECT');
      expect(html).toContain('assistant-lock.png');
    }
  }
});
