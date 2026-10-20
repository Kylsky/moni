import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type AppLocale, message } from '@/lib/locale';

export function ChatMarkdown({
  text,
  locale,
}: {
  text: string;
  locale: AppLocale;
}) {
  return (
    <div className="min-w-0 space-y-3 [&_a]:underline [&_a]:underline-offset-4 [&_a:focus-visible]:outline-4 [&_a:focus-visible]:outline-focus [&_blockquote]:border-l-2 [&_blockquote]:border-muted [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-muted/50 [&_code]:px-1 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:font-bold [&_h4]:font-bold [&_li+li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:whitespace-pre-wrap [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-muted/50 [&_pre]:p-3 [&_pre]:text-sm [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_td]:border [&_td]:border-muted [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:border-muted [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-start [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          table: ({ children }) => (
            <section
              className="max-w-full overflow-x-auto rounded-lg focus-visible:outline-4 focus-visible:outline-focus"
              aria-label={message('chat_table', locale)}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll wide reply tables.
              tabIndex={0}
            >
              <table>{children}</table>
            </section>
          ),
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
