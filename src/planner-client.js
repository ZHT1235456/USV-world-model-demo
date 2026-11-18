export class PlannerClient {
  constructor(urls) {
    this.worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
    this.waiting = new Map();
    this.nextId = 0;
    this.failure = null;
    this.worker.addEventListener('message', ({ data }) => {
      if (data.error && data.id === undefined) {
        this.fail(new Error(data.error));
        return;
      }
      const callback = this.waiting.get(data.id);
      if (!callback) return;
      this.waiting.delete(data.id);
      if (data.error) callback.reject(new Error(data.error));
      else callback.resolve(data.result);
    });
    this.worker.addEventListener('error', (event) => this.fail(new Error(event.message || '推理进程无法启动')));
    this.ready = this.request('initialize', { urls });
  }

  fail(error) {
    this.failure = error;
    for (const task of this.waiting.values()) task.reject(error);
    this.waiting.clear();
  }

  request(type, options = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, ...options });
    });
  }

  observe(rgb, command, time) {
    this.worker.postMessage({ type: 'observe', rgb, command, time }, [rgb.buffer]);
  }

  close() {
    this.worker.terminate();
    this.fail(new Error('推理进程已关闭'));
  }
}
