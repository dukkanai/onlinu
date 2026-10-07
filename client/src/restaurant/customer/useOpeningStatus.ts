import {useCallback, useEffect, useRef, useState} from 'react';
import {storefront} from '../api';
import {createOpeningMonitor, type OpeningStatus} from './opening-status';

export function useOpeningStatus() {
  const [status, setStatus] = useState<OpeningStatus | null>(null);
  const monitor = useRef<ReturnType<typeof createOpeningMonitor> | null>(null);
  useEffect(() => {
    const current = createOpeningMonitor({
      read: signal => storefront<unknown>('/opening-status', {signal}),
      changed: setStatus,
      visible: () => document.visibilityState !== 'hidden',
      schedule: (run, delay) => { const id = window.setTimeout(run, delay); return () => window.clearTimeout(id); },
    });
    monitor.current = current;
    document.addEventListener('visibilitychange', current.refresh);
    current.refresh();
    return () => { current.stop(); document.removeEventListener('visibilitychange', current.refresh); if (monitor.current === current) monitor.current = null; };
  }, []);
  return {status, refresh: useCallback(() => monitor.current?.refresh(), [])};
}
