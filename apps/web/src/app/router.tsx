import { createBrowserRouter } from 'react-router-dom';
import { AppLayout } from './AppLayout.js';
import { AlarmsPage } from '../pages/AlarmsPage.js';
import { DevicePage } from '../pages/DevicePage.js';
import { OverviewPage } from '../pages/OverviewPage.js';

/** Маршруты приложения. Каталог pages содержит только композицию, вся логика в features. */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'device/:code', element: <DevicePage /> },
      { path: 'alarms', element: <AlarmsPage /> },
    ],
  },
]);
