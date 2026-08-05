import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { AuthProvider } from './auth/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './layout/AppShell';
import Access from './pages/Access';
import Assets from './pages/Assets';
import AssetModels from './pages/AssetModels';
import Audit from './pages/Audit';
import Clients from './pages/Clients';
import Dev from './pages/Dev';
import External from './pages/External';
import Home from './pages/Home';
import Partners from './pages/Partners';
import Login from './pages/Login';
import Profile from './pages/Profile';
import Settings from './pages/Settings';
import Sites from './pages/Sites';
import Users from './pages/Users';
import Variables from './pages/Variables';
import Workers from './pages/Workers';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <ProtectedRoute>
                <AppShell>
                  <Outlet />
                </AppShell>
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<ProtectedRoute resource="dashboard"><Home /></ProtectedRoute>} />
            <Route path="/assets" element={<ProtectedRoute resource="assets"><Assets /></ProtectedRoute>} />
            <Route path="/sites" element={<ProtectedRoute resource="sites"><Sites /></ProtectedRoute>} />
            <Route path="/people/users" element={<ProtectedRoute resource="users"><Users /></ProtectedRoute>} />
            <Route path="/people/workers" element={<ProtectedRoute resource="workers"><Workers /></ProtectedRoute>} />
            <Route path="/people/external" element={<ProtectedRoute resource="users"><External /></ProtectedRoute>} />
            <Route path="/stakeholders/clients" element={<ProtectedRoute resource="clients"><Clients /></ProtectedRoute>} />
            <Route path="/stakeholders/partners" element={<ProtectedRoute resource="partners"><Partners /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute resource="settings"><Settings /></ProtectedRoute>} />
            <Route path="/access" element={<ProtectedRoute resource="access"><Access /></ProtectedRoute>} />
            <Route path="/admin/asset-models" element={
              <ProtectedRoute resource="asset_models"><AssetModels /></ProtectedRoute>
            } />
            <Route path="/admin/audit" element={<ProtectedRoute resource="audit"><Audit /></ProtectedRoute>} />
            <Route path="/dev" element={<ProtectedRoute resource="devtools"><Dev /></ProtectedRoute>} />
            <Route path="/dev/database/variables" element={
              <ProtectedRoute resource="devtools"><Variables /></ProtectedRoute>
            } />
            <Route path="/me" element={<Profile />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
