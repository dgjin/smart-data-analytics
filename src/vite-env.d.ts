/// <reference types="vite/client" />

/**
 * 应用版本号环境变量：由 vite.config.ts 的 define（import.meta.env 通道）从 package.json 注入。
 * 界面展示版本（如 Header 徽标）一律读 import.meta.env.VITE_APP_VERSION，发版只需升 package.json。
 * 注意：Vite 6 dev 模式不替换顶层 define 的用户常量，经 import.meta.env 通道才能 dev/生产行为一致。
 */
interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
}
