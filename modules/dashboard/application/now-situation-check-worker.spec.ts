import { describe, expect, it, vi } from 'vitest';
import { NowSituationCheckWorker } from './now-situation-check-worker';

const push = { key: 'e:still_low:1', kind: 'still_low' as const, title: 'Po węglach: 64', body: 'Minęło 15 min' };

function setup(overrides: Record<string, unknown> = {}) {
  const deps = {
    listPatients: vi.fn(async () => ['p']),
    listDevices: vi.fn(async () => [{ push_token: 'a' }, { push_token: 'b' }]),
    hasRecentCarbs: vi.fn(async () => true),
    dashboard: vi.fn(async () => ({ dashboard: {} as never, sources: { readings: [], loopStatus: null } })),
    checkPush: vi.fn(async () => push),
    claim: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  };
  return { deps, worker: new NowSituationCheckWorker(deps as never) };
}

describe('NowSituationCheckWorker', () => {
  it('sends to every phone', async () => {
    const { worker, deps } = setup();
    expect(await worker.run()).toBe(1);
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('leaves out a phone whose own low alert says it, and keeps the claim when every phone has one', async () => {
    const below = { ...push, key: 'e:below_low', kind: 'below_low' as const, skip_if_low_alert: true };
    const mixed = setup({ checkPush: vi.fn(async () => below), listDevices: vi.fn(async () => [{ push_token: 'a', low_alert_on: true }, { push_token: 'b', low_alert_on: false }]) });
    await mixed.worker.run();
    expect(mixed.deps.send).toHaveBeenCalledTimes(1);
    expect(mixed.deps.send).toHaveBeenCalledWith(expect.objectContaining({ pushToken: 'b' }));
    const all = setup({ checkPush: vi.fn(async () => below), listDevices: vi.fn(async () => [{ push_token: 'a', low_alert_on: true }]) });
    await all.worker.run();
    expect(all.deps.send).not.toHaveBeenCalled();
    expect(all.deps.release).not.toHaveBeenCalled();
  });

  it('reads nothing more without recent carbs', async () => {
    const { worker, deps } = setup({ hasRecentCarbs: vi.fn(async () => false) });
    expect(await worker.run()).toBe(0);
    expect(deps.dashboard).not.toHaveBeenCalled();
  });

  it('a claim already taken sends nothing', async () => {
    const { worker, deps } = setup({ claim: vi.fn(async () => false) });
    await worker.run();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('one failing phone still counts; no phone reached gives the claim back', async () => {
    const one = setup({ send: vi.fn(async (input: { pushToken: string }) => { if (input.pushToken === 'a') throw new Error('x'); }) });
    expect(await one.worker.run()).toBe(1);
    expect(one.deps.release).not.toHaveBeenCalled();
    const none = setup({ send: vi.fn(async () => { throw new Error('x'); }) });
    expect(await none.worker.run()).toBe(0);
    expect(none.deps.release).toHaveBeenCalledWith('p', push.key);
  });

  it('one patient failing does not stop the next', async () => {
    const { worker } = setup({ listPatients: vi.fn(async () => ['bad', 'p']), hasRecentCarbs: vi.fn(async (id: string) => { if (id === 'bad') throw new Error('x'); return true; }) });
    expect(await worker.run()).toBe(1);
  });
});
