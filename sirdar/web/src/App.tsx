import { Link, Route, Routes } from 'react-router-dom';

import Gate from './auth/Gate';
import RequireAuth from './auth/RequireAuth';
import SirdarShell from './layout/SirdarShell';
import Access from './pages/Access';
import Audit from './pages/Audit';
import Dashboard from './pages/Dashboard';
import Me from './pages/Me';
import Settings from './pages/Settings';
import SirdarLogin from './pages/SirdarLogin';
import UserDetail from './pages/UserDetail';
import Users from './pages/Users';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<SirdarLogin />} />
      <Route path="/*" element={
        <RequireAuth>
          <SirdarShell>
            <Routes>
              <Route path="/" element={<Gate resource="dashboard"><Dashboard /></Gate>} />
              <Route path="/admin/users" element={<Gate resource="users"><Users /></Gate>} />
              <Route path="/admin/users/:personId" element={<Gate resource="users"><UserDetail /></Gate>} />
              <Route path="/admin/access" element={<Gate resource="access"><Access /></Gate>} />
              <Route path="/admin/audit" element={<Gate resource="audit"><Audit /></Gate>} />
              <Route path="/settings" element={<Gate resource="settings"><Settings /></Gate>} />
              <Route path="/me" element={<Me />} />
              <Route path="*" element={
                <div className="portal-page">
                  <p className="page-hint">Page not found. <Link to="/">Back to the dashboard</Link></p>
                </div>
              } />
            </Routes>
          </SirdarShell>
        </RequireAuth>
      } />
    </Routes>
  );
}
