import { type AppLocale, message } from './locale';

const defaultLabels = {
  'expense-uncategorized': 'category_uncategorized',
  'income-uncategorized': 'category_uncategorized',
  'expense-food': 'category_food',
  'expense-sports': 'category_sports',
  'expense-clothing': 'category_clothing',
  'expense-transport': 'category_transport',
  'expense-home': 'category_home',
  'expense-entertainment': 'category_entertainment',
  'expense-other': 'category_other',
  'income-other': 'category_other',
  'income-salary': 'category_salary',
  'income-freelance': 'category_freelance',
} as const;

export function categoryLabel(
  name: string,
  key: string | null,
  locale: AppLocale
) {
  const messageKey = key
    ? defaultLabels[key as keyof typeof defaultLabels]
    : null;
  return messageKey ? message(messageKey, locale) : name;
}
