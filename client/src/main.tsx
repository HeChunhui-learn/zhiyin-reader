import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import App from './App'
import { SessionProvider } from './state/session'
import { SettingsProvider } from './features/settings/SettingsProvider'
import UpdateGate from './features/app/UpdateGate'
import WebUpdateBanner from './features/app/WebUpdateBanner'
import { isNativeApp } from './api/platform'
import './app.css'

/**
 * 原生壳里用 HashRouter。
 *
 * Capacitor 的 WebView 从本地 assets 取页面，没有 nginx 的 SPA 回退；应用被系统
 * 回收后恢复、或手动刷新时，`/read/xxx` 这种路径会直接找不到文件。Hash 路由把
 * 路径放在 `#` 后面，页面地址永远是 index.html，刷新也不会 404。
 * 浏览器端保持原来的 BrowserRouter，地址栏观感不变。
 */
const Router = isNativeApp() ? HashRouter : BrowserRouter

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Router>
      {/* SettingsProvider 放在 SessionProvider 外面：主题与登录态无关，
          放里面的话引导页和登录页吃不到，切夜晚模式后进这些页会突变成白的 */}
      <SettingsProvider>
        <SessionProvider>
          {/* 强制更新闸门：原生壳里发现版本落后就盖一层不可关闭的弹窗 */}
          <UpdateGate>
            {/* 网页版（手机 / 平板）的轻提示；原生壳由 UpdateGate 接管 */}
            <WebUpdateBanner />
            <App />
          </UpdateGate>
        </SessionProvider>
      </SettingsProvider>
    </Router>
  </React.StrictMode>,
)
