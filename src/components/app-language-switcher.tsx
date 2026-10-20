import { IconLanguage } from '@tabler/icons-react';
import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { LanguagePreference, useAppLocale } from '@/hooks/use-app-locale';
import { message } from '@/lib/locale';

export function AppLanguageSwitcher({
  language,
}: {
  language: ReturnType<typeof useAppLocale>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="app-language-trigger"
        className={buttonVariants({ variant: 'icon' })}
        aria-label={`${message('language_label', language.locale)}: ${language.locale}`}
      >
        <IconLanguage size={21} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={message('language_label', language.locale)}
      >
        <DropdownMenuRadioGroup
          value={language.preference}
          onValueChange={(value) =>
            language.selectLanguage(value as LanguagePreference)
          }
        >
          {(['browser', 'zh', 'en'] as const).map((value) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              data-app-language={value}
              className="min-h-11"
            >
              {value === 'browser'
                ? message('app_browser_language', language.locale)
                : value === 'zh'
                  ? '简体中文'
                  : 'English'}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
