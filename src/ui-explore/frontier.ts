import { Mutex } from 'async-mutex';
import type { FrontierTask } from './types.js';

/**
 * FrontierQueue — async-mutex-guarded priority task queue.
 * Priority: lower depth tasks are popped first.
 */
export class FrontierQueue {
  private queue: FrontierTask[] = [];
  private mutex = new Mutex();

  async push(task: FrontierTask): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      this.queue.push(task);
      // Keep sorted: lower depth first (priority queue via sort)
      this.queue.sort((a, b) => a.depth - b.depth);
    } finally {
      release();
    }
  }

  async pop(): Promise<FrontierTask | null> {
    const release = await this.mutex.acquire();
    try {
      return this.queue.shift() ?? null;
    } finally {
      release();
    }
  }

  async size(): Promise<number> {
    const release = await this.mutex.acquire();
    try {
      return this.queue.length;
    } finally {
      release();
    }
  }

  async drain(): Promise<FrontierTask[]> {
    const release = await this.mutex.acquire();
    try {
      const remaining = [...this.queue];
      this.queue = [];
      return remaining;
    } finally {
      release();
    }
  }
}
