import * as Control from "./control"
import { Objects, streamStats } from "./objects"
import { SubgroupReader } from "./subgroup"
import type { SubgroupData } from "./subscriber"
import { asError } from "../common/error"
import { ControlStream } from "./stream"

import { Publisher } from "./publisher"
import { Subscriber } from "./subscriber"

export class Connection {
	// The established WebTransport session.
	#quic: WebTransport

	// Use to receive/send control messages.
	#controlStream: ControlStream

	// Use to receive/send objects.
	#objects: Objects

	// Module for contributing tracks.
	#publisher: Publisher

	// Module for distributing tracks.
	#subscriber: Subscriber

	// Async work running in the background
	#running: Promise<void>

	// Set when close() is called to suppress expected errors
	#closed = false

	constructor(quic: WebTransport, stream: ControlStream, objects: Objects) {
		this.#quic = quic
		this.#controlStream = stream
		this.#objects = objects

		this.#publisher = new Publisher(this.#controlStream, this.#objects)
		this.#subscriber = new Subscriber(this.#controlStream, this.#objects)

		this.#running = this.#run()
	}

	close(code = 0, reason = "") {
		this.#closed = true
		this.#quic.close({ closeCode: code, reason })
	}

	// Check if an error is expected during session close
	#isCloseError(e: unknown): boolean {
		if (this.#closed) return true
		if (e instanceof Error) {
			const msg = e.message
			// RESET_STREAM is normal congestion control — NOT a close error
			if (msg.includes("RESET_STREAM")) return false
			if (typeof WebTransportError !== "undefined" && e instanceof WebTransportError) return true
			if (msg.includes("session is closed") || msg.includes("unexpected end of stream")) return true
		}
		return false
	}

	async #run(): Promise<void> {
		await Promise.all([this.#runControl(), this.#runObjects()])
	}

	publish_namespace(namespace: string[]) {
		return this.#publisher.publish_namespace(namespace)
	}

	publishedNamespaces() {
		return this.#subscriber.publishedNamespaces()
	}

	subscribe(namespace: string[], track: string) {
		return this.#subscriber.subscribe(namespace, track)
	}

	unsubscribe(track: string) {
		return this.#subscriber.unsubscribe(track)
	}

	subscribed() {
		return this.#publisher.subscribed()
	}

	async #runControl() {
		// Receive messages until the connection is closed.
		try {
			console.log("starting control loop")
			for (; ;) {
				const msg = await this.#controlStream.recv()
				await this.#recv(msg)
			}
		} catch (e) {
			if (this.#isCloseError(e)) return
			console.error("Error in control stream:", e)
			throw e
		}
	}

	async #runObjects() {
		let received = 0
		let errors = 0
		const hb = setInterval(() => {
			const inflight = streamStats.opened - streamStats.closed
			console.warn(`[OBJECTS-LOOP] heartbeat: received=${received} errors=${errors} streams_open=${streamStats.opened} streams_closed=${streamStats.closed} inflight=${inflight}`)
		}, 5000)
		try {
			for (; ;) {
				try {
					const reader = await this.#objects.recv()
					if (!reader) {
						console.warn(`[OBJECTS-LOOP] recv returned undefined — loop ending`)
						break
					}

					// Process each stream in the BACKGROUND — never block the accept loop.
					// This prevents a slow/stuck stream from blocking all other streams.
					received++
					if (reader instanceof SubgroupReader) {
						this.#processSubgroup(reader).catch((e) => {
							errors++
							if (!this.#isCloseError(e)) {
								console.warn(`[OBJECTS-LOOP] stream processing error:`, e)
							}
						})
					} else {
						// Unknown reader type — close immediately
						reader.close().catch(() => {})
					}
				} catch (e) {
					errors++
					if (this.#closed) {
						console.warn(`[OBJECTS-LOOP] connection closed — loop ending`)
						return
					}
					console.warn(`[OBJECTS-LOOP] skipping errored stream #${errors}:`, e)
					continue
				}
			}
		} catch (e) {
			if (this.#isCloseError(e)) return
			console.error(`[OBJECTS-LOOP] FATAL: received=${received} errors=${errors}`, e)
			throw e
		} finally {
			clearInterval(hb)
			console.warn(`[OBJECTS-LOOP] DEAD. received=${received} errors=${errors}`)
		}
	}

	// Read ALL objects from a subgroup stream, dispatching each to the subscriber.
	// No timeout — streams end naturally when the publisher FINs them.
	// This avoids sending STOP_SENDING which can cause the relay to stop forwarding.
	async #processSubgroup(reader: SubgroupReader) {
		try {
			for (; ;) {
				const obj = await reader.read()
				if (!obj) break
				this.#subscriber.recvData({ header: reader.header, object: obj })
			}
		} catch (e) {
			if (!this.#isCloseError(e)) {
				console.warn(`[OBJECTS-LOOP] stream read error (alias=${reader.header.track_alias}):`, e)
			}
		} finally {
			try { await reader.close() } catch {}
		}
	}

	async #recv(msg: Control.MessageWithType) {
		if (Control.isPublisher(msg.type)) {
			await this.#subscriber.recv(msg)
		} else {
			await this.#publisher.recv(msg)
		}
	}

	async closed(): Promise<Error> {
		try {
			await this.#running
			return new Error("closed")
		} catch (e) {
			return asError(e)
		}
	}
}
