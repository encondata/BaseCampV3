/**
 * The plan tab's writes, one at a time in the order asked. Each job starts
 * once the one before it has settled, so it reads the version that one
 * answered: two edits typed quickly never race each other into a 409
 * `plan_changed`. A job that fails rejects its own caller only.
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
