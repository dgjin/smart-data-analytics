import React, { useEffect, lazy, Suspense } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { QueryChat } from './components/query/QueryChat';
import { ReportGenerator } from './components/reports/ReportGenerator';
import { DataSourceManager } from './components/datasource/DataSourceManager';
import { Login } from './components/auth/Login';
import { ForceChangePassword } from './components/auth/ForceChangePassword';
import { AdminPanel } from './components/admin/AdminPanel';
import { useAnalyticsStore } from './hooks/useAnalyticsStore';
import { useAuthStore } from './hooks/useAuthStore';

// v0.4.14：bundle 优化——重组件懒加载（减少首屏体积）
const CustomDashboard = lazy(() => import('./components/dashboard/CustomDashboard').then((m) => ({ default: m.CustomDashboard })));
const FlexQueryBuilder = lazy(() => import('./components/flexquery/FlexQueryBuilder').then((m) => ({ default: m.FlexQueryBuilder })));
// v0.5.0：智能问数报告中心（问数报告模式生成的报告列表与详情）
const QueryReportCenter = lazy(() => import('./components/reports/QueryReportCenter').then((m) => ({ default: m.QueryReportCenter })));

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
    if (user.role === 'VIEWER' && (activeTab === 'query' || activeTab === 'flexquery')) {
      setActiveTab('dashboard');
    } else if (user.role !== 'ADMIN' && (activeTab === 'datasources' || activeTab === 'admin')) {
      setActiveTab('dashboard');
    }
  }, [user, activeTab, setActiveTab]);

  if (!token || !user) {
    return <Login />;
  }

  // P0-1 首登/被重置密码：强制改密前不渲染任何业务界面
  if (user.mustChangePassword) {
    return <ForceChangePassword />;
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'query':
        return user.role === 'VIEWER' ? <CustomDashboard /> : <QueryChat />;
      case 'reports':
        return <ReportGenerator />;
      case 'query-reports':
        return <QueryReportCenter />;
      case 'datasources':
        return user.role === 'ADMIN' ? <DataSourceManager /> : <CustomDashboard />;
      case 'admin':
        return user.role === 'ADMIN' ? <AdminPanel /> : <CustomDashboard />;
      case 'dashboard':
        return <CustomDashboard />;
      case 'flexquery':
        return user.role === 'VIEWER' ? <CustomDashboard /> : <FlexQueryBuilder />;
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
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-500 text-sm">加载中…</div>}>
            {renderTabContent()}
          </Suspense>
        </main>
      </div>
    </div>
  );
}
