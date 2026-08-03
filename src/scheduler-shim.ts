/**
 * Local shim for `scan-engine/scheduler` — the published scan-engine@0.1.3
 * doesn't export `./scheduler` (its exports map predates the multi-entry
 * build). This is a verbatim copy of the scheduler source. Once scan-engine
 * publishes a version with the scheduler export, delete this file and the
 * Vite alias in vite.config.ts.
 */
export type Cancel = () => void;

export interface Scheduler {
  schedule(fn: () => void, delayMs: number): Cancel;
  now(): number;
}

export function systemScheduler(): Scheduler {
  return {
    schedule(fn, delayMs) {
      const handle = setTimeout(fn, delayMs);
      return () => clearTimeout(handle);
    },
    now() {
      return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    },
  };
}

interface PendingJob {
  fn: () => void;
  deadline: number;
  seq: number;
}

export interface ManualScheduler extends Scheduler {
  time(): number;
  advanceBy(ms: number): void;
  advanceTo(timestamp: number): void;
  flush(): void;
  pending(): number;
}

export function manualScheduler(startAt: number = 0): ManualScheduler {
  let time = startAt;
  let seq = 0;
  const queue: PendingJob[] = [];

  function fireDue() {
    queue.sort((a, b) => a.deadline - b.deadline || a.seq - b.seq);
    while (queue.length > 0 && queue[0].deadline <= time) {
      const job = queue.shift()!;
      job.fn();
    }
  }

  return {
    schedule(fn, delayMs) {
      const deadline = time + Math.max(0, delayMs);
      const mySeq = seq++;
      const job: PendingJob = { fn, deadline, seq: mySeq };
      queue.push(job);
      return () => {
        const idx = queue.indexOf(job);
        if (idx >= 0) queue.splice(idx, 1);
      };
    },
    now() {
      return time;
    },
    time() {
      return time;
    },
    advanceBy(ms) {
      time += ms;
      fireDue();
    },
    advanceTo(timestamp) {
      time = Math.max(time, timestamp);
      fireDue();
    },
    flush() {
      queue.sort((a, b) => a.deadline - b.deadline || a.seq - b.seq);
      while (queue.length > 0) {
        const job = queue.shift()!;
        time = Math.max(time, job.deadline);
        job.fn();
      }
    },
    pending() {
      return queue.length;
    },
  };
}
