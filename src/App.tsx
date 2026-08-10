import React, { useEffect } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { QueryChat } from './components/query/QueryChat';
import { ReportGenerator } from './components/reports/ReportGenerator';
import { DataSourceManager } from './components/datasource/DataSourceManager';
import { CustomDashboard } from './components/dashboard/CustomDashboard';
import { Login } from './components/auth/Login';
import { AdminPanel } from './components/admin/AdminPanel';
import { useAnalyticsStore } from './hooks/useAnalyticsStore';
import { useAuthStore } from './hooks/useAuthStore';

export default function App() {
  const { activeTab, setActiveTab, loadDataSources } = useAnalyticsStore();
  const { token, user } = useAuthStore();

  // 登录后从服务端加载数据源
  useEffect(() => {
    if (token) {
      loadDataSources();
    }
  }, [token, loadDataSources]);

  // Tab 角色守卫：越权访问时重定向到看板页
  useEffect(() => {
    if (!user) return;
    if (user.role === 'VIEWER' && activeTab === 'query') {
      setActiveTab('dashboard');
    } else if (user.role !== 'ADMIN' && (activeTab === 'datasources' || activeTab === 'admin')) {
      setActiveTab('dashboard');
    }
  }, [user, activeTab, setActiveTab]);

  if (!token || !user) {
    return <Login />;
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'query':
        return user.role === 'VIEWER' ? <CustomDashboard /> : <QueryChat />;
      case 'reports':
        return <ReportGenerator />;
      case 'datasources':
        return user.role === 'ADMIN' ? <DataSourceManager /> : <CustomDashboard />;
      case 'admin':
        return user.role === 'ADMIN' ? <AdminPanel /> : <CustomDashboard />;
      case 'dashboard':
        return <CustomDashboard />;
      default:
        return <QueryChat />;
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans antialiased">
      {/* Top Header */}
      <Header />

      {/* Main Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Navigation Sidebar */}
        <Sidebar />

        {/* Right Active View Content */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          {renderTabContent()}
        </main>
      </div>
    </div>
  );
}
