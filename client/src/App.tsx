import { Component, lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
const GuidingUI = lazy(() => import('./pages/GuidingUI'))
const LoginView = lazy(() => import('./pages/LoginView'))
const LibraryView = lazy(() => import('./pages/LibraryView'))
const ReaderView = lazy(() => import('./pages/ReaderView'))
const StatsView = lazy(() => import('./pages/StatsView'))
const ProfileView = lazy(() => import('./pages/ProfileView'))

/** 分包下载失败也提供中文提示，避免网络波动导致整页空白。 */
class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <div className="shelf-empty" role="alert">
      <p>页面加载失败，请检查网络后重试。</p>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>重新加载</button>
    </div>
    return this.props.children
  }
}

export default function App() {
  return (
    <PageErrorBoundary><Suspense fallback={<div role="status">正在加载页面…</div>}><Routes>
      <Route path="/" element={<Navigate to="/guide" replace />} />
      <Route path="/guide" element={<GuidingUI />} />
      <Route path="/login" element={<LoginView />} />
      <Route path="/shelf" element={<LibraryView />} />
      <Route path="/read/:docId" element={<ReaderView />} />
      {/* R7-5：阅读时长与个人主页。登录态由页面各自守卫（项目没有路由级守卫组件） */}
      <Route path="/stats" element={<StatsView />} />
      <Route path="/profile" element={<ProfileView />} />
      <Route path="*" element={<Navigate to="/guide" replace />} />
    </Routes></Suspense></PageErrorBoundary>
  )
}
