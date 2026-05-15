// 资源热更新服务层
// 封装 Tauri 命令调用，提供前端友好的 API

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { loggers } from '@/utils/logger';
import { isTauri } from '@/utils/paths';

const log = loggers.app;

/** 默认资源更新镜像前缀 */
export const DEFAULT_RESOURCE_UPDATE_MIRROR_PREFIX = 'https://gh-proxy.com/';

export interface ResourceUpdateMirrorSettings {
  resourceUpdateUseGithubMirrors?: boolean;
  resourceUpdateMirrorPrefix?: string;
}

/**
 * 解析为传给 Rust 的前缀列表：开启镜像时优先镜像，再回落直连。
 */
export function getResourceUpdateMirrorPrefixList(
  settings: ResourceUpdateMirrorSettings,
): string[] {
  if (settings.resourceUpdateUseGithubMirrors === false) {
    return [''];
  }
  const raw = (settings.resourceUpdateMirrorPrefix || DEFAULT_RESOURCE_UPDATE_MIRROR_PREFIX).trim();
  const normalized = raw.endsWith('/') ? raw : `${raw}/`;
  return [normalized, ''];
}

/** 资源更新检查结果 */
export interface ResourceUpdateCheckResult {
  hasUpdate: boolean;
  version?: string;
  currentVersion: string;
  filesChanged?: number;
  releaseNote?: string;
  downloadUrl?: string;
}

/**
 * 获取当前平台标签，格式与 CI artifact 名称一致（如 win-x86_64, macos-aarch64）。
 * 优先通过 Tauri 命令获取精确值，浏览器环境回退到 navigator 判断。
 */
async function getPlatformTag(): Promise<string> {
  if (isTauri()) {
    try {
      const [os, arch] = await Promise.all([invoke<string>('get_os'), invoke<string>('get_arch')]);
      const osTag = os === 'windows' ? 'win' : os === 'macos' ? 'macos' : os;
      const archTag = arch === 'x86_64' ? 'x86_64' : arch === 'aarch64' ? 'aarch64' : arch;
      return `${osTag}-${archTag}`;
    } catch {
      // fallback
    }
  }
  const ua = navigator.platform.toLowerCase();
  const os = ua.includes('win') ? 'win' : ua.includes('mac') ? 'macos' : 'linux';
  return `${os}-x86_64`;
}

/** 从 GitHub 仓库 URL 构建资源 manifest URL（带平台后缀） */
export async function buildManifestUrl(githubUrl: string): Promise<string> {
  const cleanUrl = githubUrl.replace(/\/$/, '');
  const platform = await getPlatformTag();
  log.info('资源更新平台标签:', platform);
  return `${cleanUrl}/releases/latest/download/resource-manifest-${platform}.json`;
}

/**
 * 检查资源更新
 * @param manifestUrl manifest 文件 URL
 * @param currentVersion 当前资源版本号
 */
export async function checkResourceUpdate(
  manifestUrl: string,
  currentVersion: string,
  mirrorPrefixes: string[],
): Promise<ResourceUpdateCheckResult> {
  log.info('检查资源更新:', manifestUrl, '当前版本:', currentVersion);
  try {
    const result = await invoke<ResourceUpdateCheckResult>('check_resource_update', {
      manifestUrl,
      currentVersion,
      mirrorPrefixes,
    });
    return result;
  } catch (err) {
    log.error('检查资源更新失败:', err);
    throw err;
  }
}

/** 资源下载进度事件 */
export interface ResourceUpdateProgressEvent {
  url: string;
  downloadedSize: number;
  totalSize: number;
  speed: number;
  progress: number;
}

/**
 * 应用资源更新
 * @param downloadUrl 资源包下载 URL
 * @param manifest manifest 内容（用于更新本地 .manifest.json）
 * @param onProgress 下载进度回调
 */
export async function applyResourceUpdate(
  downloadUrl: string,
  manifest: object,
  mirrorPrefixes: string[],
  onProgress?: (progress: ResourceUpdateProgressEvent) => void,
): Promise<void> {
  log.info('应用资源更新:', downloadUrl);

  let unlisten: (() => void) | undefined;

  try {
    // 监听 Rust 端的下载进度事件
    unlisten = await listen<ResourceUpdateProgressEvent>('resource-update-progress', (event) => {
      onProgress?.(event.payload);
    });

    await invoke('apply_resource_update', {
      downloadUrl,
      manifest,
      mirrorPrefixes,
    });
    log.info('资源更新应用成功');
  } catch (err) {
    log.error('应用资源更新失败:', err);
    throw err;
  } finally {
    unlisten?.();
  }
}
