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
