import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { BurrowWebPlugin } from '@burrow/sdk';
import { createBurrowRouter } from './router';
import { WebPluginRegistryProvider } from './plugins/registry';
import { applyThemeToDom, getStoredTheme } from './lib/theme';
import './index.css';

export interface MountBurrowWebOptions {
  rootElement?: HTMLElement | null;
  plugins?: readonly BurrowWebPlugin[];
}

export function mountBurrowWeb(options: MountBurrowWebOptions = {}): void {
  const plugins = options.plugins ?? [];
  applyThemeToDom(getStoredTheme());

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });

  const activeRouter = createBurrowRouter(plugins);
  const target = options.rootElement ?? document.getElementById('root');
  if (!target) {
    throw new Error('Burrow root element "#root" not found');
  }

  ReactDOM.createRoot(target).render(
    <React.StrictMode>
      <WebPluginRegistryProvider plugins={plugins}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={activeRouter} />
        </QueryClientProvider>
      </WebPluginRegistryProvider>
    </React.StrictMode>,
  );
}
