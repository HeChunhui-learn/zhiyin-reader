import { Navigate, Route, Routes } from 'react-router-dom'
import GuidingUI from './pages/GuidingUI'
import LoginView from './pages/LoginView'
import LibraryView from './pages/LibraryView'
import ReaderView from './pages/ReaderView'
import StatsView from './pages/StatsView'
import ProfileView from './pages/ProfileView'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/guide" replace />} />
      <Route path="/guide" element={<GuidingUI />} />
      <Route path="/login" element={<LoginView />} />
      <Route path="/shelf" element={<LibraryView />} />
      <Route path="/read/:docId" element={<ReaderView />} />
      {/* R7-5：阅读时长与个人主页。登录态由页面各自守卫（项目没有路由级守卫组件） */}
      <Route path="/stats" element={<StatsView />} />
      <Route path="/profile" element={<ProfileView />} />
      <Route path="*" element={<Navigate to="/guide" replace />} />
    </Routes>
  )
}
