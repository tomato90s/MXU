import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Download, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useShallow } from 'zustand/react/shallow';
import { applyResourceUpdate } from '@/services/resourceUpdateService';
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
    setResourceUpdateError,
  } = useAppStore(
    useShallow((state) => ({
      resourceUpdateStatus: state.resourceUpdateStatus,
      resourceUpdateInfo: state.resourceUpdateInfo,
      resourceUpdateError: state.resourceUpdateError,
      setResourceUpdateStatus: state.setResourceUpdateStatus,
      setResourceUpdateError: state.setResourceUpdateError,
    })),
  );

  const handleUpdate = useCallback(async () => {
    if (!resourceUpdateInfo) return;

    setResourceUpdateStatus('downloading');
    setResourceUpdateError(null);

    try {
      setResourceUpdateStatus('installing');
      await applyResourceUpdate(
        resourceUpdateInfo.downloadUrl,
        resourceUpdateInfo,
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
          {/* 确认模式 */}
          {!isUpdating && !isCompleted && !isError && resourceUpdateInfo && (
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
