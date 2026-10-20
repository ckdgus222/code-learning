/*
 * The shared slots between the session and a side job's worker: the flag that asks the worker to stop, and for
 * the value-shape job (plan v2.3 V-2) the TypeScript process the worker runs. That process can be stuck in a
 * request the worker waits on, so the session may end it. But a process number must never be signalled once
 * the process is gone, because the number can then belong to another one. So exactly one side takes the number
 * out of the slot, atomically, and ends the process.
 */
const STOP = 0;
const PID = 1;
const SIGNALLED = 2;

export const newStopSlots = () => new Int32Array(new SharedArrayBuffer(4 * 3));
export const stopRequested = (slots: Int32Array) => Atomics.load(slots, STOP) === 1;

/** The session's side: raises the flag and, if the number is still there, takes it and ends the process. */
export function requestStop(slots: Int32Array, kill = (pid: number) => { process.kill(pid, 'SIGKILL'); }): void {
  Atomics.store(slots, STOP, 1);
  const pid = Atomics.exchange(slots, PID, 0);
  // The process may have ended on its own, but it is not collected yet (see takeProcess), so the number is still its own.
  if (pid > 0) { try { kill(pid); } catch { /* already ended */ } }
  Atomics.store(slots, SIGNALLED, 1);
  Atomics.notify(slots, SIGNALLED);
}

/** The worker's side, right after starting the process. */
export function publishProcess(slots: Int32Array, pid: number): void {
  Atomics.store(slots, PID, pid);
}

/**
 * The worker's side when it is done with the process: true when it took the number back and must end the process
 * itself. Otherwise the session took it, and this waits until the session's signal is sent. A child process is
 * collected only by the event loop of the thread that started it, and that loop does not run during this wait or
 * during a synchronous request, so the session never signals a collected process.
 */
export function takeProcess(slots: Int32Array, pid: number): boolean {
  if (Atomics.compareExchange(slots, PID, pid, 0) === pid) return true;
  Atomics.wait(slots, SIGNALLED, 0);
  return false;
}
