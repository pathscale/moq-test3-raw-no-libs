export class Deferred<T> {
	promise: Promise<T>
	resolve!: (value: T | PromiseLike<T>) => void
	reject!: (reason: any) => void
	pending = true

	constructor() {
		this.promise = new Promise((resolve, reject) => {
			this.resolve = (value) => {
				this.pending = false
				resolve(value)
			}
			this.reject = (reason) => {
				this.pending = false
				reject(reason)
			}
		})
	}
}

export type WatchNext<T> = [T, Promise<WatchNext<T>> | undefined]

export class Watch<T> {
	#current: WatchNext<T>
	#next = new Deferred<WatchNext<T>>()

	constructor(init: T) {
		this.#next = new Deferred<WatchNext<T>>()
		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		this.#current = [init, this.#next.promise]
	}

	value(): WatchNext<T> {
		return this.#current
	}

	update(v: T | ((v: T) => T)) {
		if (!this.#next.pending) {
			throw new Error("already closed")
		}

		// If we're given a function, call it with the current value
		if (v instanceof Function) {
			v = v(this.#current[0])
		}

		const next = new Deferred<WatchNext<T>>()
		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		this.#current = [v, next.promise]
		this.#next.resolve(this.#current)
		this.#next = next
	}

	close() {
		this.#current[1] = undefined
		this.#next.resolve(this.#current)
	}
}

// Wakes up a multiple consumers.
export class Notify {
	#next = new Deferred<void>()

	async wait() {
		return this.#next.promise
	}

	wake() {
		if (!this.#next.pending) {
			throw new Error("closed")
		}

		this.#next.resolve()
		this.#next = new Deferred<void>()
	}

	close() {
		this.#next.resolve()
	}
}

// Allows queuing N values, like a Channel.
export class Queue<T> {
	#stream: TransformStream<T, T>
	#closed = false

	constructor(capacity = 1) {
		const queue = new CountQueuingStrategy({ highWaterMark: capacity })
		this.#stream = new TransformStream({}, undefined, queue)
	}

	async push(v: T) {
		if (this.#closed) return
		const w = this.#stream.writable.getWriter()
		try {
			await w.write(v)
		} finally {
			w.releaseLock()
		}
	}

	async next(): Promise<T | undefined> {
		const r = this.#stream.readable.getReader()
		const { value, done } = await r.read()
		r.releaseLock()

		if (done) return
		return value
	}

	async abort(err: Error) {
		if (this.#closed) return
		this.#closed = true
		try {
			const w = this.#stream.writable.getWriter()
			await w.abort(err)
			w.releaseLock()
		} catch {
			// Stream may already be closed or errored
		}
	}

	async close() {
		if (this.#closed) return
		this.#closed = true
		try {
			// Acquire writer lock to avoid "Cannot close a locked stream" when push() is in-flight
			const w = this.#stream.writable.getWriter()
			await w.close()
			w.releaseLock()
		} catch {
			// Stream may already be closed or errored — that's fine
		}
	}

	closed() {
		return this.#closed
	}
}
