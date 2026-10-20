<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/moni/brand/wordmark-on-dark-v2.png">
    <img src="public/moni/brand/wordmark-on-light.png" alt="Moni" width="180">
  </picture>
</p>

<h1 align="center">Bookkeeping, in your own words.</h1>

<p align="center">
  An open-source personal ledger. Chat in the web app or WeChat via ClawBot.<br>
  Self-hosted entirely on Cloudflare.<br>
  <strong>$0 hosting within Cloudflare's free-tier limits. You pay for AI tokens.</strong>
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/ISheepp/Moni"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>
</p>

## Tell Moni what happened

> Lunch at KFC: CNY 35. Website ads: USD 20.

Moni turns your message into separate entries, suggests categories and tags, and keeps details such as the merchant in each entry's note. It uses your custom categories and tags too.

Review and edit the draft, then confirm. If you prefer, explicitly enable **automatic posting** in Settings. Missing amounts or unclear currencies still need your input.

![Desktop draft preview with two expenses, categories, tags, notes, and original-currency amounts](docs/verification/screenshots/s4-drafts-pc.png)

## Record and query from WeChat with ClawBot

**Use Moni inside WeChat.** Deploy it once, add your AI configuration, then open **Settings → WeChat** and scan the QR code to connect ClawBot.

Send a message as you normally would:

> Lunch at KFC: CNY 35.
>
> How much did I spend on takeout over the last three months?
>
> What about last month? Show me the transactions.

- Record expenses and income, with categories, tags, and notes.
- Keep asking follow-up questions in the same WeChat conversation.
- Review a draft and confirm with a natural reply. You can also review pending drafts together and confirm the reviewed batch in WeChat.
- Use the same ledger and posting permissions as the web app; entries are available from both.

The WeChat receiver runs on Cloudflare too. You do not need to leave a computer or a separate bridge server running. Connection details are in the [WeChat guide](docs/wechat-integration.md).

## Ask your ledger questions

> How much did I spend on takeout over the last three months?
>
> What about last month?
>
> Show me the transactions.

Follow-up questions keep the conversation's filters. Totals come from queries against your posted entries, and you can open the matching transactions to check them.

<table>
  <tr>
    <th>Record an expense on your phone</th>
    <th>Ask about your spending</th>
  </tr>
  <tr>
    <td><img src="docs/verification/screenshots/s4-drafts-mobile.png" alt="Mobile chat with an editable expense draft" width="300"></td>
    <td><img src="docs/verification/screenshots/s4-query-mobile.png" alt="Mobile chat showing spending totals and a transaction-details link" width="300"></td>
  </tr>
</table>

Screenshots show v0.1 with demo data and the Chinese interface. Moni also supports English.

## What you get

- **Natural-language bookkeeping:** multiple expenses or income entries in one message, editable drafts, categories, tags, and searchable notes.
- **Natural-language queries:** date ranges, categories, tags, currencies, transaction details, and follow-up questions.
- **An optional WeChat entry point:** connect ClawBot by scanning a QR code in Settings. Use the same ledger from a dedicated WeChat conversation, with pending-draft reminders and batch confirmation.
- **Multiple currencies:** keep the original amount and a fixed conversion to your main currency. Use a reference rate, a manual rate, or the actual settled amount.
- **Everyday ledger tools:** manual entries, refunds linked to expenses, filters, reports, a recycle bin, custom categories, and tag merging.
- **Your data to keep:** filtered CSV exports and full JSON backup and restore, including notes.
- **Desktop and mobile:** English and Chinese, light and dark themes, and system theme support.

Manual bookkeeping, filters, basic reports, manual currency conversion, and backups work without AI.

## All Cloudflare. No server to maintain.

| Part | Runs on |
| --- | --- |
| Web app and API | Cloudflare Workers |
| Entries, notes, and chat history | Cloudflare D1 |
| Conversation coordination and optional WeChat receiver | SQLite-backed Durable Objects |
| Owner-only sign-in | Cloudflare Access |
| AI | Your chosen OpenAI-compatible provider, with tool-calling support |

The app and its storage run in **your Cloudflare account**. AI requests go to the provider you configure. No VPS, separate database service, or Moni subscription is required.

### What costs money?

**Hosting can be $0 while you stay within Cloudflare's free-tier quotas and runtime limits. AI token usage is billed by your provider.** Choosing a paid Cloudflare plan or buying a domain adds its own costs. The optional WeChat receiver also consumes Durable Object requests and active duration.

Check Cloudflare's current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Access](https://www.cloudflare.com/zero-trust/products/access/), and [build limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) before choosing a plan.

## Deploy

You need a GitHub account and a Cloudflare account. AI and WeChat configuration can wait until the app is running.

### Option 1: Deploy it yourself

1. Click [**Deploy to Cloudflare**](https://deploy.workers.cloudflare.com/?url=https://github.com/ISheepp/Moni). Sign in and connect the repository. You do not need an AI key or WeChat credentials at this step.
2. Keep the build command **`pnpm run build`** and deploy command **`pnpm run deploy`**. Cloudflare prepares the Worker, D1, and Durable Objects; the deploy command applies database migrations.
3. Open the generated `workers.dev` address. Follow the setup page to enable **Cloudflare Access for all traffic**, allow only your own identity, and configure `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and `OWNER_SUBJECT` as Worker Secrets. Business data remains inaccessible until this is complete.
4. Sign in, choose your main currency and time zone, and start using the ledger.
5. When ready, add your AI key, base URL, model, and API type in **Settings → AI assistant**. To use WeChat, scan the QR code under **Settings → WeChat**.

A custom domain is optional. Detailed Access configuration, CLI deployment, and upgrades are covered in the [deployment guide](docs/deployment.md) (Chinese).

### Option 2: Ask a coding agent to deploy it

Give your agent this repository and the prompt below. Complete account sign-ins and identity verification yourself when needed. Add your AI key in the deployed app's Settings afterward.

```text
Help me self-host https://github.com/ISheepp/Moni in my Cloudflare account.

Read README.md and docs/deployment.md first. Use the Deploy to Cloudflare
flow, or Wrangler if CLI access is already available.

Deploy the Worker with its D1 database and SQLite Durable Objects, apply
the migrations, and configure Cloudflare Access to allow only me.
If using the CLI, create or bind D1 before running remote migrations,
and ensure the build and deploy use the same private resource configuration.
Ask me to complete account sign-ins or identity verification when needed.

Keep credentials, owner identity, account IDs, and personal resource settings
out of tracked files, logs, and chat. Use ignored local configuration and
Cloudflare Secrets. Preserve existing data and encryption secrets on upgrades;
do not change resources belonging to other projects.

Open the deployed app and check that storage is ready and anonymous requests
cannot read the ledger. Leave AI and WeChat setup to the app's Settings page.
```

## Keys and privacy

AI keys entered in Settings are encrypted on the server, are never returned to the browser after saving, and are excluded from ledger backups. Deployment generates the encryption secrets; keep them when upgrading. WeChat connects through the Settings QR flow.

Keep real keys and personal deployment settings out of Git. For local work, use an ignored `.dev.vars`; the committed [configuration example](config/local.vars.example) contains empty values only.

## Development

Requires Node.js 22.16+ and pnpm 10.30.3+.

```bash
pnpm install --frozen-lockfile
pnpm db:migrate:local
pnpm dev
```

Local browser access still requires a valid owner Access identity. Automated tests use isolated signed identities and local D1/Durable Objects without reading `.dev.vars`.

| Command | Purpose |
| --- | --- |
| `pnpm check` | Formatting, translations, unit and Worker tests, and types |
| `pnpm build` | Production build and type check |
| `pnpm e2e` | Build and run desktop/mobile browser tests |
| `pnpm check:private` | Scan source and build output for private configuration |
| `pnpm deploy:dry-run` | Package an existing build without deploying |
| `pnpm locale:compile` | Regenerate translations after editing locale files |
| `pnpm cf-typegen` | Regenerate Cloudflare binding types |

`pnpm deploy` publishes an existing build and applies remote migrations. `pnpm deploy:local` builds first, then publishes. Both change cloud resources; see the [deployment guide](docs/deployment.md) before running them.

Built with React, TypeScript, TanStack Start/Router/AI, Base UI, Tailwind CSS, and Paraglide. Icons are from Tabler.

## Project docs

- [Product specification](docs/specs/moni-v0.1.md) · [Architecture](docs/technical-design.md) · [Financial decisions](docs/adr/) · [Glossary](GLOSSARY.md)
- [WeChat setup](docs/wechat-integration.md) · [Deployment guide](docs/deployment.md)
- [v0.1 verification](docs/verification/v0.1-acceptance.md) · [Latest chat optimization](docs/verification/chat-call-efficiency.md)

Current version: v0.1. Most detailed project documentation is in Chinese.

## License and credits

[MIT](LICENSE). Started from [TanStarter Lite](https://github.com/MkFastHQ/mkfast-lite), with its original copyright notice retained. See the [asset credits](docs/design/moni-v0.1/assets/README.md) for illustrations and branding.
