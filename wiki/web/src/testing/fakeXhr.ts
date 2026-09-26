/** A stand-in XMLHttpRequest for upload tests: records each request and
 *  lets the test drive its progress and outcome. Install it with
 *  `vi.stubGlobal('XMLHttpRequest', FakeXhr)`. */
type Handler = ((ev: ProgressEvent) => void) | null;

export class FakeXhr {
  static instances: FakeXhr[] = [];
  /** When set, every send() finishes on its own with this status. */
  static autoRespond: number | null = null;

  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  aborted = false;
  upload: { onprogress: Handler } = { onprogress: null };
  onload: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
    if (FakeXhr.autoRespond !== null) {
      const status = FakeXhr.autoRespond;
      queueMicrotask(() => {
        this.progress(1, 1);
        this.respond(status);
      });
    }
  }

  abort() {
    this.aborted = true;
    this.onabort?.({} as ProgressEvent);
  }

  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }

  respond(status: number) {
    this.status = status;
    this.onload?.({} as ProgressEvent);
  }

  fail() {
    this.onerror?.({} as ProgressEvent);
  }

  static reset() {
    FakeXhr.instances = [];
    FakeXhr.autoRespond = null;
  }
}
