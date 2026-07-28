import { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import { cleanStackTrace } from '~/utils/stacktrace';

interface WebContainerContext {
  loaded: boolean;
}

export const webcontainerContext: WebContainerContext = import.meta.hot?.data.webcontainerContext ?? {
  loaded: false,
};

if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

export let webcontainer: Promise<WebContainer> = new Promise(() => {
  // noop for ssr
});

/**
 * WebContainer needs SharedArrayBuffer, which only works when:
 * 1. The page is a secure context (HTTPS or localhost)
 * 2. COOP/COEP headers make window.crossOriginIsolated === true
 */
export function getCrossOriginIsolationError(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!window.isSecureContext) {
    const httpsHost = window.location.hostname.includes('boltdiy')
      ? window.location.host
      : 'boltdiy-pqce.srv1618030.hstgr.cloud';

    return [
      'Chinna-DIY must be opened over HTTPS (secure context).',
      '',
      `You are on: ${window.location.origin}`,
      `Use: https://${httpsHost}/`,
      '',
      'HTTP on a public IP cannot use SharedArrayBuffer, so files, shell, and preview cannot start.',
    ].join('\n');
  }

  if (!window.crossOriginIsolated) {
    return [
      'This page is not cross-origin isolated (window.crossOriginIsolated is false).',
      '',
      'Required response headers:',
      '  Cross-Origin-Opener-Policy: same-origin',
      '  Cross-Origin-Embedder-Policy: credentialless',
      '',
      'Hard-refresh the tab (Ctrl+Shift+R). If it still fails, the reverse proxy may be stripping headers.',
    ].join('\n');
  }

  return null;
}

if (!import.meta.env.SSR) {
  webcontainer =
    import.meta.hot?.data.webcontainer ??
    Promise.resolve()
      .then(() => {
        const isolationError = getCrossOriginIsolationError();

        if (isolationError) {
          console.error('[WebContainer]', isolationError);
          throw new Error(isolationError);
        }

        return WebContainer.boot({
          coep: 'credentialless',
          workdirName: WORK_DIR_NAME,
          forwardPreviewErrors: true, // Enable error forwarding from iframes
        });
      })
      .then(async (webcontainer) => {
        webcontainerContext.loaded = true;

        const { workbenchStore } = await import('~/lib/stores/workbench');

        const response = await fetch('/inspector-script.js');
        const inspectorScript = await response.text();
        await webcontainer.setPreviewScript(inspectorScript);

        // Listen for preview errors
        webcontainer.on('preview-message', (message) => {
          console.log('WebContainer preview message:', message);

          // Handle both uncaught exceptions and unhandled promise rejections
          if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
            const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';
            const title = isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception';
            workbenchStore.actionAlert.set({
              type: 'preview',
              title,
              description: 'message' in message ? message.message : 'Unknown error',
              content: `Error occurred at ${message.pathname}${message.search}${message.hash}\nPort: ${message.port}\n\nStack trace:\n${cleanStackTrace(message.stack || '')}`,
              source: 'preview',
            });
          }
        });

        return webcontainer;
      });

  if (import.meta.hot) {
    import.meta.hot.data.webcontainer = webcontainer;
  }
}
