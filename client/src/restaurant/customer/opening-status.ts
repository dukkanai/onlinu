export type OpeningStatus = {
  version: number;
  scheduleEnabled: boolean;
  withinHours: boolean | null;
  acceptingOrders: boolean;
  timeZone: 'Asia/Riyadh';
  evaluatedAt: string;
};

export function parseOpeningStatus(input: unknown): OpeningStatus | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = ['version', 'scheduleEnabled', 'withinHours', 'acceptingOrders', 'timeZone', 'evaluatedAt'];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) ||
      !Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
      typeof value.scheduleEnabled !== 'boolean' || typeof value.acceptingOrders !== 'boolean' ||
      value.timeZone !== 'Asia/Riyadh' || typeof value.evaluatedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.evaluatedAt) ||
      !Number.isFinite(Date.parse(value.evaluatedAt)) ||
      (value.scheduleEnabled ? typeof value.withinHours !== 'boolean' || (value.acceptingOrders && !value.withinHours) : value.withinHours !== null)) return null;
  return value as OpeningStatus;
}

type Cancel = () => void;
export function createOpeningMonitor(options: {
  read: (signal: AbortSignal) => Promise<unknown>;
  changed: (value: OpeningStatus | null) => void;
  visible: () => boolean;
  schedule: (run: () => void, milliseconds: number) => Cancel;
}) {
  let stopped = false, generation = 0;
  let cancelPoll: Cancel = () => {}, cancelTimeout: Cancel = () => {};
  let active: AbortController | null = null;
  const cancel = () => { generation++; cancelPoll(); cancelTimeout(); active?.abort(); active = null; };
  const refresh = () => {
    if (stopped) return;
    cancel();
    if (!options.visible()) { options.changed(null); return; }
    const current = generation, request = new AbortController(); active = request;
    const finish = (value: OpeningStatus | null) => {
      if (stopped || current !== generation) return;
      cancelTimeout(); active = null; options.changed(value);
      cancelPoll = options.schedule(refresh, 30_000);
    };
    cancelTimeout = options.schedule(() => {
      if (stopped || current !== generation) return;
      generation++; request.abort(); active = null; options.changed(null);
      cancelPoll = options.schedule(refresh, 30_000);
    }, 5_000);
    void Promise.resolve().then(() => {
      if (stopped || current !== generation) throw new Error("obsolete_opening_read");
      return options.read(request.signal);
    })
      .then(value => finish(parseOpeningStatus(value)), () => finish(null));
  };
  return { refresh, stop: () => { stopped = true; cancel(); } };
}
