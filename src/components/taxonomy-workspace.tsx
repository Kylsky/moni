import { Dialog } from '@base-ui/react/dialog';
import {
  IconArrowLeft,
  IconBarbell,
  IconBriefcase,
  IconCar,
  IconCoin,
  IconDeviceGamepad,
  IconDots,
  IconHelp,
  IconHome,
  IconPencil,
  IconPlus,
  IconShirt,
  IconSoup,
  IconTag,
} from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import type { Category, Taxonomy } from '@/ledger/taxonomy';
import { categoryLabel } from '@/lib/category-label';
import { privateApi } from '@/lib/client-api';
import { type AppLocale, message } from '@/lib/locale';

type Editor =
  | { type: 'category'; kind: Category['kind']; category?: Category }
  | { type: 'tag' };
const categoryIcons: Record<string, typeof IconTag> = {
  'expense-food': IconSoup,
  'expense-sports': IconBarbell,
  'expense-clothing': IconShirt,
  'expense-transport': IconCar,
  'expense-home': IconHome,
  'expense-entertainment': IconDeviceGamepad,
  'expense-other': IconDots,
  'income-other': IconDots,
  'expense-uncategorized': IconHelp,
  'income-uncategorized': IconHelp,
  'income-salary': IconCoin,
  'income-freelance': IconBriefcase,
};

export function TaxonomyWorkspace({
  datasetId,
  locale,
}: {
  datasetId: string;
  locale: AppLocale;
}) {
  const [data, setData] = useState<Taxonomy | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'categories' | 'tags'>('categories');
  const [kind, setKind] = useState<Category['kind']>('expense');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [mergeError, setMergeError] = useState(false);
  const [notice, setNotice] = useState('');
  const operation = useRef<{ value: string; id: string } | null>(null);
  const sequence = useRef(0);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    const result = await privateApi<Taxonomy>('taxonomy');
    if (current !== sequence.current) return;
    if (result.datasetId !== datasetId) throw new Error('dataset_changed');
    setData(result);
    setFailed(false);
  }, [datasetId]);
  useEffect(() => {
    reload().catch(() => setFailed(true));
    return () => {
      sequence.current++;
    };
  }, [reload]);
  if (failed)
    return (
      <div>
        <p role="alert" className="mb-4">
          {t('taxonomy_load_error')}
        </p>
        <Button onClick={() => reload().catch(() => setFailed(true))}>
          {t('app_retry')}
        </Button>
      </div>
    );
  if (!data) return <output>{t('probe_loading')}</output>;
  const selectedTags = data.tags.filter((tag) => selected.includes(tag.id));
  const target = selectedTags.find((tag) => tag.id === targetId);
  return (
    <>
      <Link
        to="/"
        search={{ view: 'settings' }}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg font-bold focus-visible:outline-4 focus-visible:outline-focus"
      >
        <IconArrowLeft size={20} aria-hidden />
        {t('app_settings')}
      </Link>
      <h1 className="mt-2 text-3xl font-extrabold">{t('taxonomy_title')}</h1>
      <output className="mt-2 block text-sm text-positive" aria-live="polite">
        {notice}
      </output>
      <fieldset
        aria-label={t('taxonomy_title')}
        className="mt-6 grid grid-cols-2 gap-3 md:hidden"
      >
        <Button
          variant={tab === 'categories' ? 'secondary' : 'plain'}
          aria-pressed={tab === 'categories'}
          onClick={() => setTab('categories')}
        >
          {t('entry_category')}
        </Button>
        <Button
          variant={tab === 'tags' ? 'secondary' : 'plain'}
          aria-pressed={tab === 'tags'}
          onClick={() => setTab('tags')}
        >
          {t('entry_tags')}
        </Button>
      </fieldset>
      <div className="mt-6 grid min-w-0 gap-6 md:grid-cols-2">
        <section
          className={`${tab !== 'categories' ? 'hidden md:block' : ''} min-w-0 rounded-2xl border border-foreground/50 bg-surface p-4 md:p-6`}
          aria-label={t('taxonomy_categories')}
        >
          <h2 className="text-xl font-extrabold">{t('taxonomy_categories')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('taxonomy_categories_hint')}
          </p>
          <fieldset
            aria-label={t('taxonomy_category_kind')}
            className="my-5 grid grid-cols-2 gap-2"
          >
            {(['expense', 'income'] as const).map((value) => (
              <Button
                key={value}
                variant={kind === value ? 'secondary' : 'plain'}
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                disabled={busy}
              >
                {t(value === 'expense' ? 'entry_expense' : 'entry_income')}
              </Button>
            ))}
          </fieldset>
          <ul className="mb-5 divide-y divide-muted">
            {data.categories
              .filter((item) => item.kind === kind)
              .map((category) => {
                const label = categoryLabel(
                  category.name,
                  category.defaultKey,
                  locale
                );
                const Icon = category.defaultKey
                  ? (categoryIcons[category.defaultKey] ?? IconTag)
                  : IconTag;
                return (
                  <li
                    key={category.id}
                    className="flex min-h-16 items-center gap-3 py-2"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-yellow/30">
                      <Icon size={23} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 break-words font-bold">
                      {label}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`${t('taxonomy_rename')} ${label}`}
                      onClick={() =>
                        setEditor({ type: 'category', kind, category })
                      }
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-4 focus-visible:outline-focus"
                    >
                      <IconPencil aria-hidden size={22} />
                    </button>
                  </li>
                );
              })}
          </ul>
          <Button
            variant="plain"
            className="w-full"
            disabled={busy}
            onClick={() => setEditor({ type: 'category', kind })}
          >
            <IconPlus aria-hidden size={20} />
            {t('taxonomy_add_category')}
          </Button>
        </section>
        <section
          className={`${tab !== 'tags' ? 'hidden md:block' : ''} min-w-0 rounded-2xl border border-foreground/50 bg-surface p-4 md:p-6`}
          aria-label={t('taxonomy_tags')}
        >
          <h2 className="text-xl font-extrabold">{t('taxonomy_tags')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('taxonomy_tags_hint')}
          </p>
          {target && selectedTags.length >= 2 && (
            <div className="mt-5 flex items-center gap-2 rounded-xl bg-yellow/20 p-2">
              <img
                alt=""
                src="/moni/illustrations/assistant-writing.png"
                className="w-20 shrink-0"
              />
              <p className="min-w-0 break-words text-sm">
                {t('taxonomy_merge_hint')} <strong>{target.name}</strong>
              </p>
            </div>
          )}
          {!data.tags.length && (
            <p className="my-8 text-sm text-muted-foreground">
              {t('taxonomy_no_tags')}
            </p>
          )}
          <ul className="my-5 divide-y divide-muted">
            {data.tags.map((tag) => (
              <li key={tag.id}>
                <label className="flex min-h-12 cursor-pointer items-center gap-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(tag.id)}
                    disabled={busy}
                    className="size-5 shrink-0 accent-orange"
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selected, tag.id]
                        : selected.filter((id) => id !== tag.id);
                      setSelected(next);
                      setMergeError(false);
                      if (
                        (next.length === 2 && selected.length < 2) ||
                        !next.includes(targetId)
                      )
                        setTargetId(next.at(-1) ?? '');
                    }}
                  />
                  <span className="min-w-0 max-w-full break-words rounded-full bg-yellow/20 px-3 py-1 font-bold">
                    {tag.name}
                  </span>
                  <span className="ml-auto shrink-0 text-sm text-muted-foreground">
                    {tag.entryCount}{' '}
                    {t(
                      tag.entryCount === 1
                        ? 'taxonomy_record_one'
                        : 'taxonomy_record_many'
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {selectedTags.length >= 2 && (
            <div className="mb-4">
              <label htmlFor="merge-target" className="font-bold">
                {t('taxonomy_target')}
              </label>
              <select
                id="merge-target"
                disabled={busy}
                className="moni-field mt-2"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                {selectedTags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {mergeError && (
            <p role="alert" className="mb-4 font-bold">
              {t(
                selectedTags.length > 21
                  ? 'taxonomy_merge_limit'
                  : 'taxonomy_save_error'
              )}
            </p>
          )}
          <Button
            className="mb-3 w-full"
            disabled={busy || selectedTags.length < 2 || !target}
            onClick={async () => {
              if (!target || busy) return;
              if (selectedTags.length > 21) {
                setMergeError(true);
                return;
              }
              const body = {
                datasetId,
                sources: selectedTags
                  .filter((tag) => tag.id !== target.id)
                  .map(({ id, version }) => ({ id, version })),
                target: { id: target.id, version: target.version },
              };
              const value = JSON.stringify(body);
              if (operation.current?.value !== value)
                operation.current = { value, id: crypto.randomUUID() };
              setBusy(true);
              setMergeError(false);
              setNotice('');
              try {
                await privateApi('tags/merge', {
                  ...body,
                  operationId: operation.current.id,
                });
                await reload();
                setSelected([]);
                setTargetId('');
                setNotice(t('taxonomy_merged'));
              } catch {
                setMergeError(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t(busy ? 'app_saving' : 'taxonomy_merge')}
          </Button>
          <Button
            variant="plain"
            className="w-full"
            disabled={busy}
            onClick={() => setEditor({ type: 'tag' })}
          >
            <IconPlus size={20} aria-hidden />
            {t('taxonomy_add_tag')}
          </Button>
        </section>
      </div>
      {editor && (
        <NameEditor
          key={
            editor.type === 'category'
              ? (editor.category?.id ?? 'new-category')
              : 'new-tag'
          }
          editor={editor}
          datasetId={datasetId}
          locale={locale}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await reload();
            setEditor(null);
            setNotice(t('taxonomy_saved'));
          }}
        />
      )}
    </>
  );
}

function NameEditor({
  editor,
  datasetId,
  locale,
  onClose,
  onSaved,
}: {
  editor: Editor;
  datasetId: string;
  locale: AppLocale;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const category = editor.type === 'category' ? editor.category : undefined;
  const original = category
    ? categoryLabel(category.name, category.defaultKey, locale)
    : '';
  const [name, setName] = useState(original);
  const [id] = useState(() => category?.id ?? crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<{ value: string; id: string } | null>(null);
  const t = (key: Parameters<typeof message>[0]) => message(key, locale);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/45" />
        <Dialog.Popup
          initialFocus={input}
          finalFocus
          className="fixed inset-x-4 top-1/2 z-50 mx-auto max-h-[90dvh] max-w-md -translate-y-1/2 overflow-y-auto overscroll-contain rounded-2xl border-2 border-ink bg-surface p-6"
        >
          <Dialog.Title className="text-2xl font-extrabold">
            {t(
              category
                ? 'taxonomy_rename'
                : editor.type === 'tag'
                  ? 'taxonomy_add_tag'
                  : 'taxonomy_add_category'
            )}
          </Dialog.Title>
          <Dialog.Description className="mt-3 text-sm text-muted-foreground">
            {t(
              editor.type === 'tag'
                ? 'taxonomy_tag_limit'
                : 'taxonomy_category_limit'
            )}
          </Dialog.Description>
          <form
            className="mt-6"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              const value = name.trim();
              const max = editor.type === 'tag' ? 30 : 50;
              if (!value || value.length > max) {
                setInvalid(true);
                input.current?.focus();
                return;
              }
              if (category && value === original) {
                onClose();
                return;
              }
              const body = {
                datasetId,
                id,
                name: value,
                ...(category
                  ? { version: category.version }
                  : editor.type === 'category'
                    ? { kind: editor.kind }
                    : {}),
              };
              const encoded = JSON.stringify(body);
              if (operation.current?.value !== encoded)
                operation.current = { value: encoded, id: crypto.randomUUID() };
              setBusy(true);
              setError(false);
              setInvalid(false);
              try {
                await privateApi(
                  editor.type === 'tag' ? 'tags' : 'categories',
                  { ...body, operationId: operation.current.id },
                  category ? 'PUT' : 'POST'
                );
                await onSaved();
              } catch {
                setError(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label htmlFor="taxonomy-name" className="font-bold">
              {t('entry_name')}
            </label>
            <input
              ref={input}
              id="taxonomy-name"
              required
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={invalid}
              aria-describedby={
                invalid || error ? 'taxonomy-name-error' : undefined
              }
              className="moni-field mt-2"
            />
            {(error || invalid) && (
              <p
                role="alert"
                id="taxonomy-name-error"
                className="mt-4 font-bold"
              >
                {t(invalid ? 'taxonomy_name_error' : 'taxonomy_save_error')}
              </p>
            )}
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Button type="submit" disabled={busy}>
                {t(busy ? 'app_saving' : 'taxonomy_save')}
              </Button>
              <Dialog.Close
                disabled={busy}
                className={buttonVariants({ variant: 'plain' })}
              >
                {t('entry_cancel')}
              </Dialog.Close>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
