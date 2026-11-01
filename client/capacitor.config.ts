import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 原生壳配置。
 *
 * · webDir 指向 Vite 的构建产物，`npm run build && npx cap sync android` 后
 *   整个前端会被拷进 APK 的 assets，启动不依赖网络。
 * · androidScheme 用 http：后端部署在 http://123.56.172.230（暂无域名与证书），
 *   若 WebView 跑在 https://localhost 上，请求 http 接口会被当成混合内容拦掉。
 *   http://localhost 在 WebView 里仍算安全上下文，localStorage / crypto.randomUUID
 *   都正常。
 * · 包名定了就别改，Android 上改 applicationId 等于换了一个 App。
 */
const config: CapacitorConfig = {
  appId: 'com.zhiyin.reader',
  appName: '知音漫卷',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#ffffff',
  },
}

export default config
