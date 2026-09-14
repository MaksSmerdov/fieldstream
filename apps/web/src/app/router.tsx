import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout.js';
import { RequireAuth } from './RequireAuth.js';
import { AlarmsPage } from '../pages/AlarmsPage.js';
import { DevicePage } from '../pages/DevicePage.js';
import { LabPage } from '../pages/LabPage.js';
import { LoginPage } from '../pages/LoginPage.js';
import { OverviewPage } from '../pages/OverviewPage.js';
import { PipelinePage } from '../pages/PipelinePage.js';

/** Маршруты приложения. Каталог pages содержит только композицию, вся логика в features. */
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'device/:code', element: <DevicePage /> },
          { path: 'alarms', element: <AlarmsPage /> },
          { path: 'pipeline', element: <PipelinePage /> },
          { path: 'lab', element: <LabPage /> },
        ],
      },
    ],
  },
]);
