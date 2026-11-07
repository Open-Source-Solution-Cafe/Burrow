import { Languages } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation, type Locale } from '../../lib/i18n';

export function LanguageSelector({ className }: { className?: string }) {
  const { locale, setLocale } = useTranslation();
  const languages: Array<{ code: Locale; label: string }> = [
    { code: 'en', label: 'EN' },
    { code: 'es', label: 'ES' },
    { code: 'fr', label: 'FR' },
  ];

  return (
    <div
      role="group"
      aria-label="Language selector"
      className={`inline-flex items-center text-xs font-mono font-medium ${className ?? ''}`}
    >
      {languages.map((lang, index) => (
        <span key={lang.code} className="inline-flex items-center">
          {index > 0 && <span className="text-[var(--muted)]/40 px-1 select-none">|</span>}
          <button
            type="button"
            onClick={() => setLocale(lang.code)}
            className={`cursor-pointer px-1 py-0.5 theme-radius-xs transition ${
              locale === lang.code
                ? 'text-[var(--accent)] font-bold underline'
                : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
            aria-label={`Switch language to ${lang.label}`}
          >
            {lang.label}
          </button>
        </span>
      ))}
    </div>
  );
}

export function LanguageToggle({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useTranslation();
  const locales: Locale[] = ['en', 'es', 'fr'];
  const labels: Record<Locale, string> = {
    en: 'English',
    es: 'Español',
    fr: 'Français',
  };

  const handleCycle = () => {
    const currentIndex = locales.indexOf(locale);
    const nextLocale = locales[(currentIndex + 1) % locales.length] ?? 'en';
    setLocale(nextLocale);
    toast.success(t('sidebar.languageSwitched', { language: labels[nextLocale] }));
  };

  return (
    <button
      type="button"
      onClick={handleCycle}
      className={`relative flex h-11 w-11 md:h-8 md:w-8 items-center justify-center theme-radius-md text-ink-muted hover:text-text hover:bg-hi transition cursor-pointer ${className}`.trim()}
      title={`${t('sidebar.language')}: ${labels[locale] || 'English'} (Click to switch)`}
      aria-label={`${t('sidebar.language')}: ${labels[locale] || 'English'}`}
    >
      <Languages className="w-4 h-4" />
      <span className="absolute bottom-1 right-1 text-[9px] font-mono font-bold leading-none uppercase text-accent">
        {locale}
      </span>
    </button>
  );
}
