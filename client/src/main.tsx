import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { SessionProvider } from './state/session'
import { SettingsProvider } from './features/settings/SettingsProvider'
import './app.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* SettingsProvider 放在 SessionProvider 外面：主题与登录态无关，
          放里面的话引导页和登录页吃不到，切夜晚模式后进这些页会突变成白的 */}
      <SettingsProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </SettingsProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
