import { Route, Routes } from 'react-router-dom';

import RequireAuth from './auth/RequireAuth';
import SirdarLogin from './pages/SirdarLogin';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<SirdarLogin />} />
      <Route path="/*" element={<RequireAuth><div className="portal-page">Signed in</div></RequireAuth>} />
    </Routes>
  );
}
