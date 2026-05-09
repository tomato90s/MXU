import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import { ResourceUpdateModal } from './ResourceUpdateModal';

export function ResourceUpdateButton() {
  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(false);

  const {
    resourceVersion,
    resourceUpdateStatus,
    resourceUpdateInfo,
  } = useAppStore(
    useShallow((state) => ({
      resourceVersion: state.resourceVersion,
      resourceUpdateStatus: state.resourceUpdateStatus,
      resourceUpdateInfo: state.resourceUpdateInfo,
    })),
  );

  const hasUpdate = resourceUpdateStatus === 'available';
  const isChecking = resourceUpdateStatus === 'checking';

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className={clsx(
          'flex items-center gap-1.5 px-2 py-1 rounded-md text-sm transition-colors relative',
          hasUpdate
            ? 'bg-accent/10 text-accent hover:bg-accent/20'
            : 'text-text-secondary hover:bg-bg-hover',
        )}
        title={
          hasUpdate && resourceUpdateInfo
            ? t('resourceUpdate.newVersionAvailable', { version: resourceUpdateInfo.version })
            : t('resourceUpdate.check')
        }
      >
        {isChecking ? (
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5" />
        )}
        <span>
          {resourceVersion ?? t('resourceUpdate.check')}
        </span>
        {hasUpdate && (
          <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500" />
        )}
      </button>

      {showModal && (
        <ResourceUpdateModal onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
