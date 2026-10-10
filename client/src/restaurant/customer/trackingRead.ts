// A lookup supersedes an earlier poll. Its old completion must not replace the
// selected order, display an obsolete error, or unlock a newer request.
export function createTrackingReadGuard() {
  let active: AbortController | null = null;
  return {
    begin() {
      if (active) return null;
      const controller = new AbortController();
      active = controller;
      return {
        signal: controller.signal,
        current: () => active === controller && !controller.signal.aborted,
        finish: () => { if (active === controller) active = null; },
      };
    },
    invalidate() {
      active?.abort();
      active = null;
    },
  };
}
