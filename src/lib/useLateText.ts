import { useSyncExternalStore } from 'react'
import { getCopyGeneration, subscribeCopy } from '../config/copy'
import { getDeploymentConfig, subscribeDeploymentConfig } from './deploymentConfig'

/**
 * Renders the caller again when a language catalogue or a station config lands after it mounted.
 * For a `memo` component that reads `appConfig.copy` or the config in render: a parent's render
 * no longer reaches it, so it subscribes itself (components/TopBar, workspace/WorkspaceTopBar).
 */
export function useLateText(): void {
  useSyncExternalStore(subscribeDeploymentConfig, getDeploymentConfig)
  useSyncExternalStore(subscribeCopy, getCopyGeneration)
}
