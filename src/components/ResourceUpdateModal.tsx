import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Download, CheckCircle, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useShallow } from 'zustand/react/shallow';
import {
  applyResourceUpdate,
  buildManifestUrl,
  checkResourceUpdate,
  getResourceUpdateMirrorPrefixList,
} from '@/services/resourceUpdateService';
import { autoLoadInterface } from '@/services/interfaceLoader';
import { loggers } from '@/utils/logger';

interface ResourceUpdateModalProps {
  onClose: () => void;
}

const log = loggers.app;

export function ResourceUpdateModal({ onClose }: ResourceUpdateModalProps) {
  const { t } = useTranslation();

  const {
    resourceUpdateStatus,
    resourceUpdateInfo,
    resourceUpdateError,
    setResourceUpdateStatus,
    setResourceUpdateInfo,
    setResourceUpdateError,
  } = useAppStore(
    useShallow((state) => ({
      resourceUpdateStatus: state.resourceUpdateStatus,
      resourceUpdateInfo: state.resourceUpdateInfo,
      resourceUpdateError: state.resourceUpdateError,
      setResourceUpdateStatus: state.setResourceUpdateStatus,
      setResourceUpdateInfo: state.setResourceUpdateInfo,
      setResourceUpdateError: state.setResourceUpdateError,
    })),
  );

  /** 打开弹窗后拉取 manifest；与「自动检查」解耦，避免无信息时白屏 */
  const [manifestPhase, setManifestPhase] = useState<'loading' | 'ready'>('loading');
  const [manifestError, setManifestError] = useState<string | null>(null);
  // 递增请求序号，防止旧请求结果覆盖新请求状态
  const checkSeqRef = useRef(0);

  const runManifestCheck = useCallback(
    async (signal?: { cancelled: boolean }) => {
      const requestSeq = ++checkSeqRef.current;
      const isStale = () => requestSeq !== checkSeqRef.current;
      setManifestError(null);
      setManifestPhase('loading');
      setResourceUpdateError(null);
      setResourceUpdateStatus('checking');

      const st0 = useAppStore.getState();
      const pi = st0.projectInterface;
      const prevInfo = st0.resourceUpdateInfo;
      if (!pi?.github?.trim() || !pi?.version) {
        if (signal?.cancelled || isStale()) return;
        // 若已有“有更新”信息，避免被缺字段检查覆盖
        if (prevInfo && prevInfo.version !== prevInfo.currentVersion) {
          setResourceUpdateStatus('available');
          setManifestPhase('ready');
          return;
        }
        setResourceUpdateInfo(null);
        setResourceUpdateStatus('idle');
        setManifestError(t('resourceUpdate.missingGithub'));
        setManifestPhase('ready');
        return;
      }

      try {
        const manifestUrl = buildManifestUrl(pi.github);
        const st = useAppStore.getState();
        const mirrorPrefixes = getResourceUpdateMirrorPrefixList({
          resourceUpdateUseGithubMirrors: st.resourceUpdateUseGithubMirrors,
          resourceUpdateMirrorPrefix: st.resourceUpdateMirrorPrefix,
        });
        const result = await checkResourceUpdate(manifestUrl, pi.version, mirrorPrefixes);
        if (signal?.cancelled || isStale()) return;
        if (result.hasUpdate) {
          setResourceUpdateInfo({
            version: result.version!,
            currentVersion: result.currentVersion,
            filesChanged: result.filesChanged ?? 0,
            releaseNote: result.releaseNote,
            downloadUrl: result.downloadUrl!,
          });
          setResourceUpdateStatus('available');
        } else {
          // 防止“后到的无更新”覆盖“先到的有更新”（常见于并发检查/镜像缓存差异）
          if (prevInfo && prevInfo.version !== prevInfo.currentVersion) {
            setResourceUpdateStatus('available');
            setManifestPhase('ready');
            return;
          }
          setResourceUpdateInfo(null);
          setResourceUpdateStatus('idle');
        }
        setManifestPhase('ready');
      } catch (err) {
        if (signal?.cancelled || isStale()) return;
        log.warn('资源更新检查失败:', err);
        // 失败时保留已有更新信息，避免误判为“无更新”
        if (prevInfo && prevInfo.version !== prevInfo.currentVersion) {
          setResourceUpdateStatus('available');
          setManifestPhase('ready');
          return;
        }
        setResourceUpdateInfo(null);
        setResourceUpdateStatus('idle');
        setManifestError(err instanceof Error ? err.message : String(err));
        setManifestPhase('ready');
      }
    },
    [setResourceUpdateError, setResourceUpdateInfo, setResourceUpdateStatus, t],
  );

  useEffect(() => {
    const sig = { cancelled: false };
    void runManifestCheck(sig);
    return () => {
      sig.cancelled = true;
    };
  }, [runManifestCheck]);

  const handleUpdate = useCallback(async () => {
    if (!resourceUpdateInfo) return;

    setResourceUpdateStatus('downloading');
    setResourceUpdateError(null);

    try {
      setResourceUpdateStatus('installing');
      const st = useAppStore.getState();
      const mirrorPrefixes = getResourceUpdateMirrorPrefixList({
        resourceUpdateUseGithubMirrors: st.resourceUpdateUseGithubMirrors,
        resourceUpdateMirrorPrefix: st.resourceUpdateMirrorPrefix,
      });
      await applyResourceUpdate(
        resourceUpdateInfo.downloadUrl,
        resourceUpdateInfo,
        mirrorPrefixes,
      );
      setResourceUpdateStatus('completed');

      // 重新加载 interface.json
      log.info('资源更新完成，重新加载 interface...');
      const result = await autoLoadInterface();
      const store = useAppStore.getState();
      store.setProjectInterface(result.interface);
      store.setBasePath(result.basePath);
      store.setDataPath(result.dataPath);
      for (const [lang, trans] of Object.entries(result.translations)) {
        store.setInterfaceTranslations(lang, trans);
      }
      store.setResourceVersion(result.interface.version || null);
      log.info('interface 重新加载完成');
    } catch (err) {
      log.error('资源更新失败:', err);
      setResourceUpdateStatus('error');
      setResourceUpdateError(err instanceof Error ? err.message : String(err));
    }
  }, [resourceUpdateInfo, setResourceUpdateStatus, setResourceUpdateError]);

  const isUpdating =
    resourceUpdateStatus === 'downloading' || resourceUpdateStatus === 'installing';
  const isCompleted = resourceUpdateStatus === 'completed';
  const isError = resourceUpdateStatus === 'error';

  const showManifestLoading = manifestPhase === 'loading' && !isUpdating && !isCompleted && !isError;
  const showManifestFetchError =
    manifestPhase === 'ready' && manifestError && !isUpdating && !isCompleted && !isError;
  const showNoUpdate =
    manifestPhase === 'ready' &&
    !manifestError &&
    !resourceUpdateInfo &&
    !isUpdating &&
    !isCompleted &&
    !isError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-bg-primary rounded-lg shadow-lg border border-border w-full max-w-md mx-4 overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-base font-semibold text-text-primary">
            {isCompleted
              ? t('resourceUpdate.completed')
              : isError
                ? t('resourceUpdate.errorTitle')
                : t('resourceUpdate.title')}
          </h3>
          {!isUpdating && (
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-bg-hover text-text-secondary transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* 内容区 */}
        <div className="px-4 py-4 space-y-4">
          {showManifestLoading && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Loader2 className="w-8 h-8 animate-spin text-accent" />
              <p className="text-sm text-text-secondary text-center">
                {t('resourceUpdate.checkingManifest')}
              </p>
            </div>
          )}

          {showManifestFetchError && (
            <div className="space-y-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                <p className="text-sm text-text-primary break-words">{manifestError}</p>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void runManifestCheck()}
                  className="px-4 py-2 rounded-md text-sm bg-accent text-white hover:bg-accent-hover transition-colors inline-flex items-center gap-1.5"
                >
                  <RefreshCw className="w-4 h-4" />
                  {t('resourceUpdate.retryCheck')}
                </button>
              </div>
            </div>
          )}

          {showNoUpdate && (
            <div className="py-2 space-y-4">
              <p className="text-sm text-text-secondary">
                {t('resourceUpdate.upToDate')}
              </p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => void runManifestCheck()}
                  className="px-4 py-2 rounded-md text-sm text-text-secondary hover:bg-bg-hover transition-colors inline-flex items-center gap-1.5"
                >
                  <RefreshCw className="w-4 h-4" />
                  {t('resourceUpdate.retryCheck')}
                </button>
              </div>
            </div>
          )}

          {/* 确认模式（manifest 检查结束后再展示，避免与 loading 叠闪） */}
          {!isUpdating &&
            !isCompleted &&
            !isError &&
            manifestPhase === 'ready' &&
            resourceUpdateInfo && (
            <>
              <div className="space-y-2">
                <p className="text-text-primary">
                  {t('resourceUpdate.newVersionAvailable', {
                    version: resourceUpdateInfo.version,
                  })}
                </p>
                <p className="text-sm text-text-secondary">
                  {t('resourceUpdate.currentVersion', {
                    version: resourceUpdateInfo.currentVersion,
                  })}
                </p>
                {resourceUpdateInfo.filesChanged !== undefined && (
                  <p className="text-sm text-text-secondary">
                    {t('resourceUpdate.filesChanged', {
                      count: resourceUpdateInfo.filesChanged,
                    })}
                  </p>
                )}
              </div>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-md text-sm text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  {t('common.later')}
                </button>
                <button
                  onClick={handleUpdate}
                  className="px-4 py-2 rounded-md text-sm bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  {t('resourceUpdate.updateNow')}
                </button>
              </div>
            </>
          )}

          {/* 更新中 */}
          {isUpdating && (
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 className="w-8 h-8 animate-spin text-accent" />
              <p className="text-text-primary">
                {resourceUpdateStatus === 'downloading'
                  ? t('resourceUpdate.downloading')
                  : t('resourceUpdate.installing')}
              </p>
            </div>
          )}

          {/* 完成 */}
          {isCompleted && (
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle className="w-8 h-8 text-green-500" />
              <p className="text-text-primary">{t('resourceUpdate.completed')}</p>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md text-sm bg-accent text-white hover:bg-accent-hover transition-colors"
              >
                {t('common.confirm')}
              </button>
            </div>
          )}

          {/* 错误 */}
          {isError && (
            <div className="flex flex-col items-center gap-3 py-4">
              <AlertCircle className="w-8 h-8 text-red-500" />
              <p className="text-text-primary">{t('resourceUpdate.errorTitle')}</p>
              {resourceUpdateError && (
                <p className="text-sm text-text-secondary text-center max-w-full break-words">
                  {resourceUpdateError}
                </p>
              )}
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-md text-sm text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  {t('common.close')}
                </button>
                <button
                  onClick={handleUpdate}
                  className="px-4 py-2 rounded-md text-sm bg-accent text-white hover:bg-accent-hover transition-colors"
                >
                  {t('common.retry')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
