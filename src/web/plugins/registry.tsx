import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type {
  BurrowWebPlugin,
  CardTypeContribution,
  MentionKindContribution,
  SettingsSectionContribution,
  SidebarPanelContribution,
  SlashCommandContribution,
  WebRouteContribution,
} from '@burrow/sdk';

export interface WebPluginRegistryValue {
  plugins: readonly BurrowWebPlugin[];
  slashCommands: readonly SlashCommandContribution[];
  mentionKinds: readonly MentionKindContribution[];
  cardTypes: readonly CardTypeContribution[];
  sidebarPanels: readonly SidebarPanelContribution[];
  settingsSections: readonly SettingsSectionContribution[];
  routes: readonly WebRouteContribution[];
}

const EMPTY_REGISTRY: WebPluginRegistryValue = {
  plugins: [],
  slashCommands: [],
  mentionKinds: [],
  cardTypes: [],
  sidebarPanels: [],
  settingsSections: [],
  routes: [],
};

const WebPluginContext = createContext<WebPluginRegistryValue>(EMPTY_REGISTRY);

export function buildWebPluginRegistry(
  plugins: readonly BurrowWebPlugin[] = [],
): WebPluginRegistryValue {
  const slashCommands: SlashCommandContribution[] = [];
  const mentionKinds: MentionKindContribution[] = [];
  const cardTypes: CardTypeContribution[] = [];
  const sidebarPanels: SidebarPanelContribution[] = [];
  const settingsSections: SettingsSectionContribution[] = [];
  const routes: WebRouteContribution[] = [];

  for (const plugin of plugins) {
    if (!plugin.manifest.permissions.includes('ui:register')) {
      throw new Error(
        `Web plugin "${plugin.manifest.id}" lacks required permission "ui:register"`,
      );
    }
    if (
      plugin.cardTypes &&
      plugin.cardTypes.length > 0 &&
      !plugin.manifest.permissions.includes('cards:register')
    ) {
      throw new Error(
        `Web plugin "${plugin.manifest.id}" registers cardTypes without required permission "cards:register"`,
      );
    }
    if (plugin.slashCommands) slashCommands.push(...plugin.slashCommands);
    if (plugin.mentionKinds) mentionKinds.push(...plugin.mentionKinds);
    if (plugin.cardTypes) cardTypes.push(...plugin.cardTypes);
    if (plugin.sidebarPanels) sidebarPanels.push(...plugin.sidebarPanels);
    if (plugin.settingsSections) settingsSections.push(...plugin.settingsSections);
    if (plugin.routes) routes.push(...plugin.routes);
  }

  sidebarPanels.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  settingsSections.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  return {
    plugins,
    slashCommands,
    mentionKinds,
    cardTypes,
    sidebarPanels,
    settingsSections,
    routes,
  };
}

export function WebPluginRegistryProvider({
  plugins = [],
  children,
}: {
  plugins?: readonly BurrowWebPlugin[];
  children: ReactNode;
}) {
  const value = useMemo(() => buildWebPluginRegistry(plugins), [plugins]);
  return <WebPluginContext.Provider value={value}>{children}</WebPluginContext.Provider>;
}

export function useWebPlugins(): WebPluginRegistryValue {
  return useContext(WebPluginContext);
}
