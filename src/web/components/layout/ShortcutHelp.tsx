import { ModalShell } from '../ui/ModalShell';
import { useTranslation } from '../../lib/i18n';

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const groups: Array<{ title: string; items: Array<[string, string]> }> = [
    {
      title: t('shortcuts.global'),
      items: [
        ['Ctrl / \u2318 K', t('shortcuts.commandPalette')],
        ['?', t('shortcuts.showHelp')],
      ],
    },
    {
      title: t('shortcuts.board'),
      items: [
        ['J / \u2193', t('shortcuts.focusNextCard')],
        ['K / \u2191', t('shortcuts.focusPrevCard')],
        ['L / \u2192', t('shortcuts.focusNextCol')],
        ['H / \u2190', t('shortcuts.focusPrevCol')],
        ['Enter', t('shortcuts.openCard')],
        ['Space', t('shortcuts.quickPeek')],
        ['C', t('shortcuts.quickAddCard')],
        ['P', t('shortcuts.setPriority')],
        ['M', t('shortcuts.setAssignee')],
      ],
    },
    {
      title: t('shortcuts.editor'),
      items: [
        ['/', t('shortcuts.slashCommands')],
        ['@', t('shortcuts.mention')],
        ['#', t('shortcuts.heading')],
      ],
    },
  ];

  return (
    <ModalShell open onClose={onClose} title={t('shortcuts.title')} className="sm:max-w-lg">
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
              {g.title}
            </div>
            <ul className="divide-y divide-hair">
              {g.items.map(([keys, desc]) => (
                <li key={desc} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                  <span className="text-muted">{desc}</span>
                  <kbd className="shrink-0 border border-line bg-surface2 px-1.5 py-0.5 font-mono text-xs text-text">
                    {keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
