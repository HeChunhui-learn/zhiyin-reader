import type { FastifyInstance } from 'fastify'

/**
 * App 版本与强制更新。
 *
 * 版本号不写死在代码里：部署时通过 /etc/zhiyin/env 覆盖，
 * 以后发新版只改环境变量和下载目录里的 APK，不用重新改代码。
 *
 * 默认值与当前 APK 一致（1.2.0 / versionCode 3）。如果环境变量没配，
 * 新装的 1.2.0 仍然能通过门槛。
 */
export interface AppVersionEnv {
  versionCode: number
  versionName: string
  apkUrl: string
  minVersionCode: number
}

export function getAppVersionEnv(): AppVersionEnv {
  const versionCode = Number(process.env.APP_VERSION_CODE ?? 3)
  const versionName = process.env.APP_VERSION_NAME ?? '1.2.0'
  const apkUrl = process.env.APP_APK_URL ?? '/download/zhiyin-1.2.0.apk'
  const minVersionCode = Number(process.env.MIN_APP_VERSION_CODE ?? versionCode)
  return { versionCode, versionName, apkUrl, minVersionCode }
}

export default async function appVersionRoutes(app: FastifyInstance) {
  // 公开接口：不登录也能查，旧版 App 也能拿到下载地址
  app.get('/api/app/version', async () => {
    const { versionCode, versionName, apkUrl, minVersionCode } = getAppVersionEnv()
    return {
      versionCode,
      versionName,
      apkUrl,
      minVersionCode,
      force: process.env.APP_FORCE_UPDATE !== 'false',
      notes: process.env.APP_UPDATE_NOTES ?? '界面视觉与阅读体验升级，更新后才能继续使用。',
    }
  })
}
