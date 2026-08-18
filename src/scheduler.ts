type Task = () => void;

export class BatchScheduler {
  private queue: Task[] = [];
  private scheduled = false;
  private flushed = 0;

  schedule(task: Task): void {
    this.queue.push(task);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  flush(): void {
    this.scheduled = false;
    if (this.queue.length === 0) return;
    const tasks = this.queue;
    this.queue = [];
    this.flushed++;
    for (const task of tasks) task();
  }

  getStats() {
    return {
      flushedBatches: this.flushed,
      queuedTasks: this.queue.length,
    };
  }
}
