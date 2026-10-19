import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import ServerLayout from './components/ServerLayout';
import Dashboard from './pages/Dashboard';
import ServerDashboard from './pages/ServerDashboard';
import ServerSettingsPage from './pages/ServerSettingsPage';
import BackupPage from './pages/BackupPage';
import RestorePage from './pages/RestorePage';
import SchedulePage from './pages/SchedulePage';
import LogsPage from './pages/LogsPage';
import LoginPage from './pages/LoginPage';

function Layout({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="layout">
      <Sidebar onLogout={onLogout} />
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/server/:id" element={<ServerLayout />}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<ServerDashboard />} />
            <Route path="backup" element={<BackupPage />} />
            <Route path="restore" element={<RestorePage />} />
            <Route path="schedule" element={<SchedulePage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="settings" element={<ServerSettingsPage />} />
          </Route>
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
