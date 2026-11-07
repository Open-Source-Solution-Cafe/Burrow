import { Moon, Sparkles, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from '../../lib/theme';
import { useTranslation } from '../../lib/i18n';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className = '' }: ThemeToggleProps) {
  const { theme, cycleTheme } = useTheme();
  const { t } = useTranslation();

  const handleToggle = () => {
    const next = cycleTheme();
    toast.success(`${t('sidebar.theme')}: ${t(`common.themes.${next}`)}`);
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={`flex h-11 w-11 md:h-8 md:w-8 items-center justify-center theme-radius-md text-ink-muted hover:text-text hover:bg-hi transition cursor-pointer ${className}`.trim()}
      title={`${t('sidebar.theme')}: ${t(`common.themes.${theme}`)}`}
      aria-label={t('sidebar.theme')}
    >
      {theme === 'modern' ? (
        <Sparkles className="w-4 h-4" />
      ) : theme === 'light' ? (
        <Sun className="w-4 h-4" />
      ) : (
        <Moon className="w-4 h-4" />
      )}
    </button>
  );
}
