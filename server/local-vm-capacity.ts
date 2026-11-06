export interface CapacityDesktop {
  key: string;
  running: boolean;
  managed: boolean;
}

/** Serializes admission and wake together: stopped private desktops consume no running slot. */
export class LocalVmCapacity {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(options: {
    key: string;
    reserve?(): () => void;
    limit: number;
    desktops(): Promise<CapacityDesktop[]>;
    busy(key: string): boolean;
    park(key: string): Promise<void>;
    wake(): Promise<T>;
    current(): boolean;
  }): Promise<T> {
    const operation = this.tail.catch(() => {}).then(async () => {
      const release = options.reserve?.();
      try {
        if (!options.current()) throw new Error("Desktop request cancelled");
        const desktops = await options.desktops();
        const running = desktops.filter(desktop => desktop.running);
        if (!running.some(desktop => desktop.key === options.key)) {
          while (running.length >= options.limit) {
            const index = running.findIndex(desktop => desktop.key !== options.key && desktop.managed && !options.busy(desktop.key));
            if (index < 0) throw new LocalVmCapacityBusy();
            if (!options.current()) throw new Error("Desktop request cancelled");
            await options.park(running[index].key);
            running.splice(index, 1);
          }
        }
        if (!options.current()) throw new Error("Desktop request cancelled");
        return await options.wake();
      } finally { release?.(); }
    });
    this.tail = operation;
    return operation;
  }
}

export class LocalVmCapacityBusy extends Error {
  constructor() { super("All active desktop slots are in use; wait for a desktop to become available."); }
}

export interface LocalVmCapacityOptions<T> {
  key: string; reserve?(): () => void; limit: number; desktops(): Promise<CapacityDesktop[]>;
  busy(key: string): boolean; park(key: string): Promise<void>; wake(): Promise<T>; current(): boolean;
}
export async function runLocalVmCapacity<T>(
  capacity: LocalVmCapacity, options: LocalVmCapacityOptions<T> & { wait?: boolean; waitMs: number; whileBusy?(): void },
): Promise<T> {
  const deadline = Date.now() + options.waitMs;
  while (options.current()) {
    options.whileBusy?.();
    try {
      return await capacity.run(options);
    } catch (error) {
      if (!(error instanceof LocalVmCapacityBusy) || !options.wait || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
  throw new Error("Desktop request cancelled");
}
