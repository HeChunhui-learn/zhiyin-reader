/// <reference types="vite/client" />

/**
 * 构建期环境变量。
 * VITE_API_BASE 只在打原生包时设置（见 package.json 的 build:android）。
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
  /** 原生包构建时注入，与 android/app/build.gradle 的 versionCode 保持一致 */
  readonly VITE_APP_VERSION_CODE?: string
  readonly VITE_APP_VERSION_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
