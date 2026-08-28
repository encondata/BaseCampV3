import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import { AuthProvider } from './auth/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './layout/AppShell';
import Access from './pages/Access';
import Assets from './pages/Assets';
import AssetDetail from './pages/AssetDetail';
import AssetModels from './pages/AssetModels';
import Audit from './pages/Audit';
import Clients from './pages/Clients';
import Containers from './pages/Containers';
import DashboardPlaceholder from './pages/DashboardPlaceholder';
import Dev from './pages/Dev';
import MoveDashboard from './pages/MoveDashboard';
import DevDatabase from './pages/DevDatabase';
import External from './pages/External';
import Home from './pages/Home';
import ImportMoveAssets from './pages/ImportMoveAssets';
import Initiatives from './pages/Initiatives';
import InitiativeDetailPage from './pages/InitiativeDetail';
import MoveAssetDetail from './pages/MoveAssetDetail';
import Partners from './pages/Partners';
import Login from './pages/Login';
import Profile from './pages/Profile';
import ProcessLogs from './pages/ProcessLogs';
import Scans from './pages/Scans';
import Settings from './pages/Settings';
import Sites from './pages/Sites';
import SiteDetail from './pages/SiteDetail';
import SystemConfig from './pages/SystemConfig';
import SystemProcesses from './pages/SystemProcesses';
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
            <Route path="/dashboards/move" element={
              <ProtectedRoute resource="dashboard"><MoveDashboard /></ProtectedRoute>
            } />
            <Route path="/dashboards/people" element={
              <ProtectedRoute resource="dashboard"><DashboardPlaceholder title="People Dashboard" /></ProtectedRoute>
            } />
            <Route path="/dashboards/clients" element={
              <ProtectedRoute resource="dashboard"><DashboardPlaceholder title="Client Dashboard" /></ProtectedRoute>
            } />
            <Route path="/assets" element={<ProtectedRoute resource="assets"><Assets /></ProtectedRoute>} />
            <Route path="/assets/:assetId" element={
              <ProtectedRoute resource="assets"><AssetDetail /></ProtectedRoute>
            } />
            <Route path="/logistics/containers" element={<ProtectedRoute resource="containers"><Containers /></ProtectedRoute>} />
            <Route path="/sites" element={<ProtectedRoute resource="sites"><Sites /></ProtectedRoute>} />
            <Route path="/sites/:siteId" element={
              <ProtectedRoute resource="sites"><SiteDetail /></ProtectedRoute>
            } />
            <Route path="/initiatives" element={
              <ProtectedRoute resource="initiatives"><Initiatives /></ProtectedRoute>
            } />
            <Route path="/initiatives/:id" element={
              <ProtectedRoute resource="initiatives"><InitiativeDetailPage /></ProtectedRoute>
            } />
            <Route path="/initiatives/:id/import-assets" element={
              <ProtectedRoute resource="initiatives"><ImportMoveAssets /></ProtectedRoute>
            } />
            <Route path="/initiatives/:id/assets/:rowId" element={
              <ProtectedRoute resource="initiatives"><MoveAssetDetail /></ProtectedRoute>
            } />
            <Route path="/people/users" element={<ProtectedRoute resource="users"><Users /></ProtectedRoute>} />
            <Route path="/people/workers" element={<ProtectedRoute resource="workers"><Workers /></ProtectedRoute>} />
            <Route path="/people/external" element={<ProtectedRoute resource="users"><External /></ProtectedRoute>} />
            <Route path="/stakeholders/clients" element={<ProtectedRoute resource="clients"><Clients /></ProtectedRoute>} />
            <Route path="/stakeholders/partners" element={<ProtectedRoute resource="partners"><Partners /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute resource="settings"><Settings /></ProtectedRoute>} />
            <Route path="/system/processes" element={
              <ProtectedRoute minRank={80}><SystemProcesses /></ProtectedRoute>
            } />
            <Route path="/system/processes/:name/logs" element={
              <ProtectedRoute resource="devtools"><ProcessLogs /></ProtectedRoute>
            } />
            <Route path="/access" element={<ProtectedRoute resource="access"><Access /></ProtectedRoute>} />
            <Route path="/admin/asset-models" element={
              <ProtectedRoute resource="asset_models"><AssetModels /></ProtectedRoute>
            } />
            <Route path="/admin/audit" element={<ProtectedRoute resource="audit"><Audit /></ProtectedRoute>} />
            <Route path="/admin/scans" element={<ProtectedRoute resource="scans"><Scans /></ProtectedRoute>} />
            <Route path="/dev" element={<ProtectedRoute resource="devtools"><Dev /></ProtectedRoute>} />
            <Route path="/dev/system-config" element={
              <ProtectedRoute resource="devtools"><SystemConfig /></ProtectedRoute>
            } />
            <Route path="/dev/database" element={
              <ProtectedRoute resource="devtools"><DevDatabase /></ProtectedRoute>
            } />
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
