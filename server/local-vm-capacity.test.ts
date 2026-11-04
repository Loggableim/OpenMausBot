import { describe, expect, it } from "vitest";
import { LocalVmCapacity, LocalVmCapacityBusy, type CapacityDesktop } from "./local-vm-capacity.ts";

describe("private desktop running capacity", () => {
  function fixture(limit = 2) {
    const pool = new LocalVmCapacity();
    const desktops: CapacityDesktop[] = [];
    const busy = new Set<string>();
    const parked: string[] = [];
    const wake = (key: string, current = () => true) => pool.run({
      key, limit, current, desktops: async () => desktops.map(d => ({ ...d })),
      busy: key => busy.has(key),
      park: async key => { parked.push(key); desktops.find(d => d.key === key)!.running = false; },
      wake: async () => {
        const existing = desktops.find(d => d.key === key);
        if (existing) existing.running = true;
        else desktops.push({ key, running: true, managed: true });
        return key;
      },
    });
    return { desktops, busy, parked, wake };
  }
  it("parks a quiet desktop and retains its private identity", async () => {
    const f = fixture();
    await f.wake("a"); await f.wake("b"); f.busy.add("a");
    await f.wake("c");
    expect(f.parked).toEqual(["b"]);
    expect(f.desktops).toHaveLength(3);
    expect(f.desktops.filter(d => d.running)).toHaveLength(2);
    await f.wake("b");
    expect(f.desktops.find(d => d.key === "b")?.running).toBe(true);
  });
  it("never parks a held or unmanaged desktop", async () => {
    const f = fixture(); await f.wake("a"); await f.wake("b");
    f.busy.add("a"); f.desktops[1].managed = false;
    await expect(f.wake("c")).rejects.toBeInstanceOf(LocalVmCapacityBusy);
    expect(f.parked).toEqual([]);
  });
  it("serializes concurrent creation and resumption", async () => {
    const f = fixture();
    f.desktops.push({ key: "parked", running: false, managed: true });
    await Promise.all([f.wake("a"), f.wake("b"), f.wake("c"), f.wake("parked")]);
    expect(f.desktops.filter(d => d.running)).toHaveLength(2);
    expect(f.desktops).toHaveLength(4);
  });
  it("allows already running desktops without evicting another", async () => {
    const f = fixture(1); await f.wake("a"); f.busy.add("a");
    await f.wake("a"); expect(f.parked).toEqual([]);
  });
  it("cancels queued work without starting or stopping a desktop", async () => {
    const f = fixture(1); await f.wake("a");
    await expect(f.wake("b", () => false)).rejects.toThrow("cancelled");
    expect(f.parked).toEqual([]);
    expect(f.desktops).toHaveLength(1);
  });
  it("does not start when parking fails and recovers its queue", async () => {
    const pool = new LocalVmCapacity();
    const wake = async () => { throw new Error("must not wake"); };
    await expect(pool.run({ key: "b", limit: 1, current: () => true,
      desktops: async () => [{ key: "a", managed: true, running: true }],
      busy: () => false, park: async () => { throw new Error("stop failed"); }, wake,
    })).rejects.toThrow("stop failed");
    await expect(pool.run({ key: "c", limit: 1, current: () => true, desktops: async () => [],
      busy: () => false, park: async () => {}, wake: async () => "ok",
    })).resolves.toBe("ok");
  });
});
