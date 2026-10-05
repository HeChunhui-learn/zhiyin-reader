import { Navigate, Route, Routes } from 'react-router-dom'
import GuidingUI from './pages/GuidingUI'
import LoginView from './pages/LoginView'
import LibraryView from './pages/LibraryView'
import ReaderView from './pages/ReaderView'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/guide" replace />} />
      <Route path="/guide" element={<GuidingUI />} />
      <Route path="/login" element={<LoginView />} />
      <Route path="/shelf" element={<LibraryView />} />
      <Route path="/read/:docId" element={<ReaderView />} />
      <Route path="*" element={<Navigate to="/guide" replace />} />
    </Routes>
  )
}
