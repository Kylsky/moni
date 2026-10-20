import { privateResponse } from './http';

type DeploymentReadiness = { database: boolean; conversations: boolean };

export async function deploymentSetupPage(request: Request, env: Env) {
  let database = false;
  try {
    // The last migration's table must exist; return no ledger values publicly.
    database = Boolean(
      await env.DB.prepare(`SELECT 1 FROM moni_state s
        JOIN datasets d ON d.id = s.active_dataset
        JOIN posting_policy p ON p.singleton = 1
        LEFT JOIN service_configuration c ON c.name = 'ai'
        WHERE s.singleton = 1 LIMIT 1`).first()
    );
  } catch {
    // Setup guidance must remain readable when a binding or migration is missing.
  }
  return restrictedPage(request, 503, {
    database,
    conversations: Boolean(env.CONVERSATIONS),
  });
}

export function restrictedPage(
  request: Request,
  status: number,
  deployment?: DeploymentReadiness
) {
  const zh =
    new URL(request.url).pathname === '/zh' ||
    request.headers.get('Accept-Language')?.toLowerCase().startsWith('zh');
  const incomplete = status === 503;
  const ready = deployment?.database && deployment.conversations;
  const title = deployment
    ? ready
      ? zh
        ? '欢迎使用 Moni'
        : 'Welcome to Moni'
      : zh
        ? '部署还差一步'
        : 'Finish deployment setup'
    : incomplete
      ? zh
        ? '配置未完成'
        : 'Setup incomplete'
      : zh
        ? '访问受限'
        : 'Access restricted';
  const description = deployment
    ? zh
      ? 'Moni 已启动。完成本人访问保护后，即可创建你的私人账本。'
      : 'Moni is running. Protect access for yourself, then create your private ledger.'
    : incomplete
      ? zh
        ? '账本暂时不可用。请由部署者检查 Cloudflare Access 与本人身份配置，然后重新验证。'
        : 'The ledger is temporarily unavailable. Ask the deployer to check Cloudflare Access and owner configuration, then verify again.'
      : zh
        ? '暂时无法验证你的访问权限。请使用已获授权的身份登录，或检查部署的访问配置。'
        : 'Your access could not be verified. Sign in with your authorized identity, or check the deployment access settings.';
  const guidance = deployment
    ? `<section aria-labelledby="deployment-status"><h2 id="deployment-status">${zh ? '部署检查' : 'Deployment checks'}</h2>
    <ul class="checks"><li>${zh ? '应用：已启动' : 'Application: running'}</li>
    <li>${zh ? '账本存储：' : 'Ledger storage: '}${deployment.database ? (zh ? '已就绪' : 'ready') : zh ? '需要完成数据库绑定与迁移' : 'complete the database binding and migrations'}</li>
    <li>${zh ? '会话存储：' : 'Conversation storage: '}${deployment.conversations ? (zh ? '已绑定' : 'bound') : zh ? '需要完成会话存储绑定' : 'complete the conversation storage binding'}</li></ul></section>
    <section aria-labelledby="next-steps"><h2 id="next-steps">${zh ? '接下来，保护你的账本' : 'Next, protect your ledger'}</h2>
    <ol><li>${zh ? '在 Cloudflare 控制台打开此应用的 Access，选择 All traffic，仅允许你本人的邮箱或身份。' : 'In the Cloudflare dashboard, open Access for this Worker, choose All traffic and allow only your own email or identity.'}</li>
    <li>${zh ? '按照部署指南，在 Cloudflare Secrets 中完成 Access 与本人身份绑定。' : 'Follow the deployment guide to configure Access and bind your owner identity using Cloudflare Secrets.'}</li>
    <li>${zh ? '重新验证访问，登录后选择主币种与时区，即可开始手动记账。' : 'Verify access again, sign in, then choose your primary currency and time zone to start manual bookkeeping.'}</li></ol></section>
    <div class="notice"><strong>${zh ? 'AI 和微信可以稍后配置' : 'AI and WeChat can wait'}</strong><p>${zh ? '无需模型 Key 或微信连接，即可完成部署。本人验证后可在设置中填写 AI 配置或扫码连接微信，也可先手动记账。' : 'Deployment needs no model key or WeChat connection. After owner verification, configure AI or scan to connect WeChat in Settings, or start with manual entries.'}</p></div>
    <p>${zh ? '此页仅提供状态与说明，不接受密钥，也不提供账本认领入口。' : 'This page provides status and instructions only. It accepts no keys and cannot assign ledger ownership.'}</p>
    <a href="https://github.com/ISheepp/Moni/blob/main/docs/deployment.md" rel="noreferrer">${zh ? '查看部署指南' : 'Read deployment guide'}</a>`
    : `<div class="notice"><strong>${incomplete ? (zh ? '必要配置未完成' : 'Required setup is incomplete') : zh ? '访问验证未完成' : 'Access verification is incomplete'}</strong><p>${zh ? '为保护你的数据安全，请完成访问验证后再使用。' : 'Complete access verification before using your private ledger.'}</p></div>
    <details><summary>${zh ? '查看配置说明' : 'View setup guidance'}</summary><p>${zh ? '请由部署者在 Cloudflare 控制台完成仅允许本人的 Access 策略和身份配置。无需在网页输入密钥或认领账本；完成后重新验证访问。' : 'The deployer must configure Cloudflare Access for the owner only and bind that identity. No keys or ledger ownership are entered here. Verify access again after setup.'}</p></details>`;
  const html = `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow"><title>${title} · Moni</title>
    <style>
      :root{color-scheme:light dark;--bg:#fff8e8;--fg:#171313;--surface:#fffdf7;--muted:#62594d}
      *{box-sizing:border-box}body{min-height:100dvh;display:flex;flex-direction:column;margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
      header{padding:24px}header img{width:112px;height:auto}.dark{display:none}
      main{width:min(100%,608px);margin:auto;padding:24px;text-align:center}main>img{width:180px;max-width:80%}
      h1{font-size:2rem;line-height:1.3}h2{font-size:1.2rem}p{color:var(--muted)}section{text-align:left;margin:24px 0;padding:0 4px}ul,ol{padding-left:24px}li{margin:12px 0}.checks{list-style:none;padding:0}.notice{margin:24px 0;padding:16px;border:1px solid #b9913d;border-radius:12px;background:#ffd65a1f;text-align:left}.notice p{margin:6px 0 0}
      a,summary{display:flex;min-height:48px;align-items:center;justify-content:center;margin-top:12px;padding:10px 24px;border:2px solid var(--fg);border-radius:12px;font-weight:700;text-decoration:none;cursor:pointer}summary,.primary{background:#ff6038;color:#171313}a{background:var(--surface);color:var(--fg)}a:focus-visible,summary:focus-visible{outline:3px solid #2b79ff;outline-offset:4px}
      @media(prefers-color-scheme:dark){:root{--bg:#181414;--fg:#fff8e8;--surface:#242020;--muted:#cec2ae}.light{display:none}.dark{display:block}}
    </style></head><body><header><img class="light" src="/moni/brand/wordmark-on-light.png" alt="Moni"><img class="dark" src="/moni/brand/wordmark-on-dark-v2.png" alt="Moni"></header>
    <main><img src="/moni/illustrations/assistant-lock.png" alt=""><h1>${title}</h1><p>${description}</p>
    ${guidance}
    <a class="${deployment ? 'primary' : ''}" href="${new URL(request.url).pathname === '/zh' ? '/zh' : '/'}">${zh ? '重新验证访问' : 'Verify access again'}</a></main></body></html>`;
  return privateResponse(
    new Response(request.method === 'HEAD' ? null : html, {
      status: deployment ? (ready ? 200 : 503) : status,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  );
}
