/**
 * PWA manifest 与图标资产校验：
 * - manifest JSON 合法且含 Chromium 可安装性必填字段（name/icons/start_url/display）；
 * - 图标文件存在，PNG 实际尺寸与声明一致（解析 IHDR，防资产错配）。
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd(); // vitest 以项目根为工作目录
const manifestPath = path.join(root, 'public', 'manifest.webmanifest');

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  theme_color?: string;
  icons?: ManifestIcon[];
}

/** 解析 PNG IHDR 宽高（8 字节签名 + 4 长度 + 4 类型 + 4 宽 + 4 高） */
function readPngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('PWA manifest', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;

  it('可安装性必填字段齐备', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#0f172a');
    expect(Array.isArray(manifest.icons)).toBe(true);
  });

  it('图标声明覆盖 192/512 与 maskable 变体', () => {
    const keys = (manifest.icons ?? []).map((icon) => `${icon.sizes}:${icon.purpose ?? 'any'}`);
    expect(keys).toContain('192x192:any');
    expect(keys).toContain('512x512:any');
    expect(keys).toContain('192x192:maskable');
    expect(keys).toContain('512x512:maskable');
  });

  it('图标文件存在且 PNG 实际尺寸与声明一致', () => {
    for (const icon of manifest.icons ?? []) {
      const file = path.join(root, 'public', icon.src.replace(/^\//, ''));
      expect(existsSync(file), `${icon.src} 应存在`).toBe(true);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(readPngSize(file), `${icon.src} 尺寸应为 ${icon.sizes}`).toEqual({ width: w, height: h });
    }
  });

  it('apple-touch 图标资产存在（index.html 引用）', () => {
    expect(existsSync(path.join(root, 'public', 'icons', 'apple-touch-icon-180.png'))).toBe(true);
  });
});
