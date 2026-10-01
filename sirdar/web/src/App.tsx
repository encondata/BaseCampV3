import { Route, Routes } from 'react-router-dom';

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
              <Route path="/" element={<Dashboard />} />
              <Route path="/admin/users" element={<Users />} />
              <Route path="/admin/users/:personId" element={<UserDetail />} />
              <Route path="/admin/access" element={<Access />} />
              <Route path="/admin/audit" element={<Audit />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/me" element={<Me />} />
            </Routes>
          </SirdarShell>
        </RequireAuth>
      } />
    </Routes>
  );
}
