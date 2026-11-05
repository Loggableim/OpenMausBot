import { LocalVmCapacity, runLocalVmCapacity, type CapacityDesktop } from "./local-vm-capacity.ts";
import type { BotRecord } from "./store.ts";
import type { ContainerComputerStatus, LocalVmTarget, Runtime } from "./container-computer.ts";
import type { LocalVmLease } from "./local-vm-lease.ts";
export interface WakePerBotContext {
  capacity: LocalVmCapacity; bots(): BotRecord[]; targetForBot(botId: string): LocalVmTarget;
  limit(): number; leaseFor(target: LocalVmTarget): LocalVmLease;
  busy(botId: string): boolean; held(botId: string): boolean; lifecycleBusy: Set<string>; activeThreads: Map<string, string>;
  setupBusy(): boolean; provision(value: boolean): void;
  desktops(runtime: Runtime): Promise<CapacityDesktop[]>; idleCancel(target: LocalVmTarget): void;
  action(action: "run" | "start" | "stop", target: LocalVmTarget): Promise<ContainerComputerStatus>;
}
export function wakePerBotLocalVm(context: WakePerBotContext, target: LocalVmTarget, action: "run" | "start", isCurrent: () => boolean, wait: boolean): Promise<ContainerComputerStatus> {
  const targets = new Map<string, { bot: BotRecord; desktop: LocalVmTarget }>();
  return runLocalVmCapacity(context.capacity, {
    key: target.key, limit: context.limit(), current: isCurrent, wait, waitMs: 90_000,
    whileBusy: () => {
      targets.clear();
      for (const bot of context.bots()) {
        const desktop = context.targetForBot(bot.id);
        targets.set(desktop.key, { bot, desktop });
      }
    },
    reserve: () => {
      if (context.setupBusy()) throw new Error("Desktop setup is in progress");
      context.provision(true);
      return () => context.provision(false);
    },
    desktops: async () => {
      const { containerRuntimeStatus } = await import("./container-computer.ts");
      const runtime = await containerRuntimeStatus();
      if (!runtime.runtime || !runtime.daemonUp) throw new Error("Container runtime is unavailable");
      return context.desktops(runtime.runtime);
    },
    busy: key => {
      const entry = targets.get(key);
      return !entry || entry.bot.busy || context.held(entry.bot.id) || context.lifecycleBusy.has(key) || context.activeThreads.has(key) || Boolean(context.leaseFor(entry.desktop).current(context.busy));
    },
    park: async key => {
      const desktop = targets.get(key)!.desktop;
      context.lifecycleBusy.add(key);
      try {
        const stopped = await context.action("stop", desktop);
        if (stopped.container === "running") throw new Error("Desktop did not stop");
        context.idleCancel(desktop);
      } finally { context.lifecycleBusy.delete(key); }
    },
    wake: () => context.action(action, target),
  });
}
