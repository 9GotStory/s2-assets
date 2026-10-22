import type { RouteObject } from 'react-router';
import { createBrowserRouter, Navigate } from 'react-router';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { AssetRegister } from './pages/AssetRegister';
import { AssetDetail } from './pages/AssetDetail';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Navigate to="/login" replace />,
  },
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/dashboard',
    element: <Dashboard />,
  },
  {
    path: '/assets/register',
    element: <AssetRegister />,
  },
  {
    path: '/assets/:id',
    element: <AssetDetail />,
  },
];

export const router = createBrowserRouter(routes);
