// 资源热更新服务层
// 封装 Tauri 命令调用，提供前端友好的 API

import { invoke } from '@tauri-apps/api/core';
import { loggers } from '@/utils/logger';

const log = loggers.app;

/** 资源更新检查结果 */
export interface ResourceUpdateCheckResult {
  hasUpdate: boolean;
  version?: string;
  currentVersion: string;
  filesChanged?: number;
  releaseNote?: string;
  downloadUrl?: string;
}

/** 从 GitHub 仓库 URL 构建资源 manifest URL */
export function buildManifestUrl(githubUrl: string): string {
  // 去除尾部斜杠
  const cleanUrl = githubUrl.replace(/\/$/, '');
  return `${cleanUrl}/releases/latest/download/resource-manifest.json`;
}

/**
 * 检查资源更新
 * @param manifestUrl manifest 文件 URL
 * @param currentVersion 当前资源版本号
 */
export async function checkResourceUpdate(
  manifestUrl: string,
  currentVersion: string,
): Promise<ResourceUpdateCheckResult> {
  log.info('检查资源更新:', manifestUrl, '当前版本:', currentVersion);
  try {
    const result = await invoke<ResourceUpdateCheckResult>('check_resource_update', {
      manifestUrl,
      currentVersion,
    });
    return result;
  } catch (err) {
    log.error('检查资源更新失败:', err);
    throw err;
  }
}

/**
 * 应用资源更新
 * @param downloadUrl 资源包下载 URL
 * @param manifest manifest 内容（用于更新本地 .manifest.json）
 */
export async function applyResourceUpdate(
  downloadUrl: string,
  manifest: object,
): Promise<void> {
  log.info('应用资源更新:', downloadUrl);
  try {
    await invoke('apply_resource_update', {
      downloadUrl,
      manifest,
    });
    log.info('资源更新应用成功');
  } catch (err) {
    log.error('应用资源更新失败:', err);
    throw err;
  }
}
