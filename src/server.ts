import server from '@tanstack/react-start/server-entry';
import { AccessError, verifyAccess } from './lib/access';
import { privateResponse } from './lib/http';
import { deploymentSetupPage, restrictedPage } from './lib/restricted-page';
import { handlePrivateApi } from './worker';

export { Conversation } from './chat-do';
export { WechatBot } from './wechat-do';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/robots.txt')
      return new Response('User-agent: *\nDisallow: /\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    if (path === '/sitemap.xml')
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>',
        { headers: { 'Content-Type': 'application/xml; charset=utf-8' } }
      );
    if (path.startsWith('/api/')) return handlePrivateApi(request, env);
    if (
      /^\/assets\/[\w.-]+\.(?:js|css|woff2|png|svg|map)$/.test(path) ||
      /^\/moni\/(?:brand|illustrations)\/[\w-]+\.png$/.test(path) ||
      path === '/favicon.svg' ||
      /^\/icons\/[\w-]+\.png$/.test(path) ||
      path === '/manifest.webmanifest'
    )
      return server.fetch(request);
    try {
      await verifyAccess(request, env);
      return privateResponse(await server.fetch(request));
    } catch (error) {
      if (
        error instanceof AccessError &&
        error.code === 'access_not_configured' &&
        (path === '/' || path === '/zh') &&
        (request.method === 'GET' || request.method === 'HEAD')
      )
        return deploymentSetupPage(request, env);
      const status = error instanceof AccessError ? error.status : 503;
      return restrictedPage(request, status);
    }
  },
} satisfies ExportedHandler<Env>;
