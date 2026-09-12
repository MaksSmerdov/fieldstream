import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { AppSession } from './app/AppSession.js';
import { ErrorBoundary } from './app/ErrorBoundary.js';
import { Providers } from './app/Providers.js';
import { router } from './app/router.js';

const container = document.querySelector('#root');
if (container === null) throw new Error('в документе нет узла #root');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <Providers>
        <AppSession>
          <RouterProvider router={router} />
        </AppSession>
      </Providers>
    </ErrorBoundary>
  </StrictMode>,
);
