/**
 * THE CLOCK THE CPU-BUDGET TESTS READ, AND IT IS CPU TIME, NOT WALL TIME.
 *
 * THIS IS A CORRECTNESS FIX, NOT A FLAKE MITIGATION, and the distinction is the whole reason it
 * is allowed to land. Cloudflare's limit -- the 10 ms in PLAN.md that this repo's p95 < 8 ms
 * invariant sits under -- is a CPU limit. `performance.now()` measures ELAPSED time, which is CPU
 * time PLUS every millisecond the process spent descheduled waiting for a core. Those two
 * quantities are equal only on an idle machine. So the budget tests were measuring the wrong
 * quantity from the day they were written; concurrency merely made the gap visible.
 *
 * MEASURED on this machine (10 logical cores, 4 of them performance cores), the same fixed work
 * sampled 60 times, p95:
 *
 *   idle                 wall 5.233 ms   cpu 5.227 ms     (identical, to 0.1 %)
 *   under 16x CPU load   wall 33.418 ms  cpu 17.621 ms    (wall x6.39, cpu x3.37)
 *
 * NOTE WHAT THAT SECOND ROW DOES NOT SAY. CPU time is NOT load-independent: under contention the
 * scheduler migrates work onto efficiency cores and the memory system is shared, so the same work
 * genuinely burns more CPU microseconds. This clock removes the DESCHEDULING component, which is
 * the dominant one and the one that has nothing to do with the code under test. It does not
 * promise a number that is invariant under load, and no assertion here should be written as if it
 * did.
 *
 * RESOLUTION, MEASURED rather than assumed, because a clock that reads precise and is not would
 * be worse than the one it replaces: the smallest non-zero delta `process.cpuUsage()` reports
 * back-to-back on this machine is 1 microsecond. Against blocks of 2-25 ms that is 0.004-0.05 %,
 * so the instrument is not the limiting factor. (It is `getrusage` underneath; a platform that
 * quantised it to the scheduler tick would make these numbers meaningless, and the check above is
 * how you would find out.)
 *
 * `user + system`, because the budget is about CPU consumed and a syscall costs the isolate just
 * as much as arithmetic does. It counts EVERY THREAD of the process, V8's background compiler and
 * GC threads included -- measured, a block short enough to overlap JIT compilation reports a
 * cpu/wall ratio of 1.68. That is why every caller warms up before it records.
 *
 * THE CAVEAT THE TWO CALLERS ALREADY CARRIED STANDS, AND IS NOW SHARPER: these are Node
 * measurements on a development machine, not workerd. What changed is that the quantity is now
 * the RIGHT KIND -- CPU rather than elapsed -- while still being measured on the wrong runtime.
 */
export const cpuMilliseconds = (): number => {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
};
