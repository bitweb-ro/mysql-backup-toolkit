import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import BackupPage from './pages/BackupPage';
import RestorePage from './pages/RestorePage';
import SchedulePage from './pages/SchedulePage';
import LoginPage from './pages/LoginPage';

function Layout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="layout">
      <Sidebar onLogout={onLogout} />
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/server/:id/backup" element={<BackupPage />} />
          <Route path="/server/:id/restore" element={<RestorePage />} />
          <Route path="/server/:id/schedule" element={<SchedulePage />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('appToken') || '');

  const handleLogout = () => {
    localStorage.removeItem('appToken');
    setToken('');
  };

  if (!token) return <LoginPage onLogin={setToken} />;

  return (
    <BrowserRouter>
      <Layout onLogout={handleLogout} />
    </BrowserRouter>
  );
}
