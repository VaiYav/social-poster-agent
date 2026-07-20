// Shared Redis mock constructor for `vi.mock('ioredis')` factories.
//
// Each test file supplies its own `Map<string, string>` store, but all IORedis
// instances created from that store share the same event bus so pub/sub works
// between separate "subscriber" and "publisher" connections (e.g. SseService).

const busMap = new WeakMap<Map<string, string>, Record<string, Array<(...args: unknown[]) => void>>>();

function getBus(store: Map<string, string>): Record<string, Array<(...args: unknown[]) => void>> {
  let bus = busMap.get(store);
  if (!bus) {
    bus = {};
    busMap.set(store, bus);
  }
  return bus;
}

function recordPostEval(
  store: Map<string, string>,
  keys: string[],
  args: string[],
): [number, number, number] {
  const [dailyKey, weeklyKey, intervalKey, lastPostAtKey] = keys;
  const [dailyLimitStr, weeklyLimitStr, intervalMsStr, nowStr] = args;
  const dailyLimit = Number(dailyLimitStr ?? '0');
  const weeklyLimit = Number(weeklyLimitStr ?? '0');
  const intervalMs = Number(intervalMsStr ?? '0');
  const now = Number(nowStr ?? '0');

  const dailyCount = Number(store.get(dailyKey) ?? '0');
  if (dailyLimit > 0 && dailyCount >= dailyLimit) {
    return [0, dailyCount, Number(store.get(weeklyKey) ?? '0')];
  }

  const weeklyCount = Number(store.get(weeklyKey) ?? '0');
  if (weeklyLimit > 0 && weeklyCount >= weeklyLimit) {
    return [0, dailyCount, weeklyCount];
  }

  const intervalTs = Number(store.get(intervalKey) ?? '0');
  if (intervalMs > 0 && intervalTs > 0 && now - intervalTs < intervalMs) {
    return [0, dailyCount, weeklyCount];
  }

  const newDaily = String(dailyCount + 1);
  const newWeekly = String(weeklyCount + 1);
  store.set(dailyKey, newDaily);
  store.set(weeklyKey, newWeekly);
  store.set(lastPostAtKey, nowStr);
  if (intervalMs > 0) {
    store.set(intervalKey, nowStr);
  }

  return [1, Number(newDaily), Number(newWeekly)];
}

export function createMockRedis(store: Map<string, string>) {
  const bus = getBus(store);
  const lists = new Map<string, string[]>();

  const on = (ev: string, cb: (...args: unknown[]) => void) => {
    (bus[ev] ??= []).push(cb);
    return inst;
  };
  const off = (ev: string, cb: (...args: unknown[]) => void) => {
    bus[ev] = (bus[ev] ?? []).filter((l) => l !== cb);
    return inst;
  };
  const once = (ev: string, cb: (...args: unknown[]) => void) => {
    const wrap = (...a: unknown[]) => {
      off(ev, wrap);
      cb(...a);
    };
    return on(ev, wrap);
  };
  const emit = (ev: string, ...args: unknown[]) => {
    (bus[ev] ?? []).forEach((l) => l(...args));
    return inst;
  };
  const removeAllListeners = (ev?: string) => {
    if (ev) bus[ev] = [];
    else for (const k in bus) bus[k] = [];
    return inst;
  };

  const inst: Record<string, unknown> = {
    status: 'ready',
    on,
    off,
    once,
    emit,
    removeAllListeners,

    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    mget: (keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
    set: (k: string, v: unknown) => { store.set(k, String(v)); return Promise.resolve('OK'); },
    setex: (k: string, _t: number, v: string) => { store.set(k, v); return Promise.resolve('OK'); },
    psetex: (k: string, _t: number, v: string) => { store.set(k, v); return Promise.resolve('OK'); },
    del: (...keys: unknown[]) => {
      const flat = keys.flat(Number.POSITIVE_INFINITY) as string[];
      let count = 0;
      for (const k of flat) {
        if (store.delete(k)) count += 1;
      }
      return Promise.resolve(count);
    },
    unlink: (...keys: unknown[]) => {
      const flat = keys.flat(Number.POSITIVE_INFINITY) as string[];
      let count = 0;
      for (const k of flat) if (store.delete(k)) count += 1;
      return Promise.resolve(count);
    },
    exists: (k: string) => Promise.resolve(store.has(k) ? 1 : 0),
    incr: (k: string) => {
      const v = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(v));
      return Promise.resolve(v);
    },
    decr: (k: string) => {
      const v = Number(store.get(k) ?? '0') - 1;
      store.set(k, String(v));
      return Promise.resolve(v);
    },
    expire: () => Promise.resolve(1),
    pexpire: () => Promise.resolve(1),
    ping: () => Promise.resolve('PONG'),
    publish: (_ch: string, msg: string) => { emit('message', _ch, msg); return Promise.resolve(1); },
    subscribe: () => Promise.resolve('OK'),
    unsubscribe: () => Promise.resolve('OK'),
    psubscribe: () => Promise.resolve('OK'),
    connect: () => Promise.resolve(undefined),
    disconnect: () => undefined,
    close: () => Promise.resolve(undefined),
    quit: () => Promise.resolve(undefined),
    duplicate: () => createMockRedis(store),
    keys: (pat: string) => {
      const prefix = pat.replace(/\*$/, '');
      return Promise.resolve([...store.keys()].filter((k) => k.startsWith(prefix)));
    },
    scan: () => Promise.resolve(['0', []]),
    hget: () => Promise.resolve(null),
    hset: () => Promise.resolve(1),
    hgetall: () => Promise.resolve({}),
    hdel: () => Promise.resolve(1),
    hlen: () => Promise.resolve(0),
    type: () => Promise.resolve('none'),

    eval: (script: unknown, numKeys: number, ...rest: unknown[]) => {
      if (typeof script === 'string' && script.includes('RECORD_POST') && numKeys === 4 && rest.length >= 4) {
        const keys = rest.slice(0, numKeys) as string[];
        const args = rest.slice(numKeys) as string[];
        return Promise.resolve(recordPostEval(store, keys, args));
      }
      // Heuristic: any 4-key call that looks like a rate-limit recordPost
      if (numKeys === 4 && rest.length >= 4 && String(rest[1]).includes('ratelimit')) {
        const keys = rest.slice(0, numKeys) as string[];
        const args = rest.slice(numKeys) as string[];
        return Promise.resolve(recordPostEval(store, keys, args));
      }
      return Promise.resolve(undefined);
    },
    evalsha: () => Promise.resolve(undefined),

    multi: () => {
      const commands: Array<{ name: string; args: unknown[]; run: () => unknown }> = [];
      const chain = {
        incr: (k: string) => { commands.push({ name: 'incr', args: [k], run: () => { const v = Number(store.get(k) ?? '0') + 1; store.set(k, String(v)); return v; } }); return chain; },
        decr: (k: string) => { commands.push({ name: 'decr', args: [k], run: () => { const v = Number(store.get(k) ?? '0') - 1; store.set(k, String(v)); return v; } }); return chain; },
        get: (k: string) => { commands.push({ name: 'get', args: [k], run: () => store.get(k) ?? null }); return chain; },
        set: (k: string, v: unknown) => { commands.push({ name: 'set', args: [k, v], run: () => { store.set(k, String(v)); return 'OK'; } }); return chain; },
        pexpire: () => { commands.push({ name: 'pexpire', args: [], run: () => 1 }); return chain; },
        expire: () => { commands.push({ name: 'expire', args: [], run: () => 1 }); return chain; },
        del: (...keys: unknown[]) => { commands.push({ name: 'del', args: keys, run: () => { let c = 0; for (const k of keys.flat(Number.POSITIVE_INFINITY) as string[]) if (store.delete(k)) c++; return c; } }); return chain; },
        exec: () => Promise.resolve(commands.map((cmd) => [null, cmd.run()])),
      };
      return chain;
    },
    pipeline: () => inst.multi(),
    batch: () => inst.multi(),
    exec: () => Promise.resolve([]),

    rpush: (k: string, ...vals: string[]) => {
      const l = lists.get(k) ?? [];
      l.push(...vals);
      lists.set(k, l);
      return Promise.resolve(l.length);
    },
    lrange: (k: string) => Promise.resolve(lists.get(k) ?? []),
    llen: (k: string) => Promise.resolve(lists.get(k)?.length ?? 0),
    lpop: (k: string) => {
      const l = lists.get(k) ?? [];
      const v = l.shift();
      lists.set(k, l);
      return Promise.resolve(v ?? null);
    },

    info: () => Promise.resolve(''),
    client: () => Promise.resolve('OK'),
    defineCommand: () => undefined,
    time: () => Promise.resolve(['0', '0']),
    wait: () => Promise.resolve(0),
  };

  queueMicrotask(() => { inst.status = 'ready'; emit('ready'); });
  return inst;
}
