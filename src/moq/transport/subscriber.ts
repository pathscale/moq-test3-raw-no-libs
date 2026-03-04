import * as Control from "./control"
import { Queue, Watch } from "../common/async"
import { Objects, streamStats } from "./objects"
import type { TrackReader } from "./objects"
import { debug } from "./utils"
import { ControlStream } from "./stream"
import { SubgroupReader, SubgroupObject } from "./subgroup"
import type { SubgroupHeader } from "./subgroup"

export interface TrackInfo {
	track_alias: bigint
	track: TrackReader | SubgroupReader
}

// Pre-read data from a SubgroupReader — the QUIC stream has already been closed.
// This prevents MAX_STREAMS exhaustion by never queuing open stream handles.
export interface SubgroupData {
	header: SubgroupHeader
	object?: SubgroupObject
}

export class Subscriber {
	// Use to send control messages.
	#control: ControlStream

	// Use to send objects.
	#objects: Objects

	// Announced broadcasts.
	#publishedNamespaces = new Map<string, PublishNamespaceRecv>()
	#publishedNamespacesQueue = new Watch<PublishNamespaceRecv[]>([])

	// Our subscribed tracks.
	#subscribe = new Map<bigint, SubscribeSend>()
	#trackToIDMap = new Map<string, bigint>()
	#trackAliasMap = new Map<bigint, bigint>() // Maps request ID to track alias
	#aliasToSubscriptionMap = new Map<bigint, bigint>() // Maps track alias to subscription ID
	#pendingTrack = new Map<bigint, (id: bigint) => Promise<void>>()

	constructor(control: ControlStream, objects: Objects) {
		this.#control = control
		this.#objects = objects
	}

	publishedNamespaces(): Watch<PublishNamespaceRecv[]> {
		return this.#publishedNamespacesQueue
	}

	async recv(msg: Control.MessageWithType) {
		const { type, message } = msg;
		switch (type) {
			case Control.ControlMessageType.PublishNamespace:
				await this.recvPublishNamespace(message)
				break
			case Control.ControlMessageType.PublishNamespaceDone:
				this.recvPublishNamespaceDone(message)
				break
			case Control.ControlMessageType.SubscribeOk:
				this.recvSubscribeOk(message)
				break
			case Control.ControlMessageType.SubscribeError:
				await this.recvSubscribeError(message)
				break
			case Control.ControlMessageType.PublishDone:
				await this.recvPublishDone(message)
				break
			default:
				throw new Error(`unknown control message`) // impossible
		}
	}

	async recvPublishNamespace(msg: Control.PublishNamespace) {
		if (this.#publishedNamespaces.has(msg.namespace.join("/"))) {
			throw new Error(`duplicate publish namespace for namespace: ${msg.namespace.join("/")}`)
		}

		await this.#control.send({
			type: Control.ControlMessageType.PublishNamespaceOk,
			message: { id: msg.id }
		})

		const publishNamespace = new PublishNamespaceRecv(this.#control, msg.namespace, msg.id)
		this.#publishedNamespaces.set(msg.namespace.join("/"), publishNamespace)

		this.#publishedNamespacesQueue.update((queue) => [...queue, publishNamespace])
	}

	recvPublishNamespaceDone(msg: Control.PublishNamespaceDone) {
		const key = msg.namespace.join("/")
		console.log(`PublishNamespaceDone received for namespace: ${key}`)
		this.#publishedNamespaces.delete(key)
	}

	async subscribe_namespace(namespace: string[]) {
		const id = this.#control.nextRequestId()
		// TODO(itzmanish): implement this
		const msg: Control.MessageWithType = {
			type: Control.ControlMessageType.SubscribeNamespace,
			message: {
				id,
				namespace,
			}
		}
		await this.#control.send(msg)
	}

	async subscribe(namespace: string[], track: string) {
		const id = this.#control.nextRequestId()

		const subscribe = new SubscribeSend(this.#control, id, namespace, track)
		this.#subscribe.set(id, subscribe)

		this.#trackToIDMap.set(track, id)

		const subscription_req: Control.MessageWithType = {
			type: Control.ControlMessageType.Subscribe,
			message: {
				id,
				namespace,
				name: track,
				subscriber_priority: 127, // default to mid value, see: https://github.com/moq-wg/moq-transport/issues/504
				group_order: Control.GroupOrder.Publisher,
				filter_type: Control.FilterType.NextGroupStart,
				forward: 1, // always forward
				params: new Map(),
			}
		}

		await this.#control.send(subscription_req)
		debug("subscribe sent", subscription_req)

		return subscribe
	}

	async unsubscribe(track: string) {
		if (this.#trackToIDMap.has(track)) {
			const trackID = this.#trackToIDMap.get(track)
			if (trackID === undefined) {
				console.warn(`Exception track ${track} not found in trackToIDMap.`)
				return
			}
			try {
				await this.#control.send({ type: Control.ControlMessageType.Unsubscribe, message: { id: trackID } })
				this.#trackToIDMap.delete(track)
			} catch (error) {
				console.error(`Failed to unsubscribe from track ${track}:`, error)
			}
		} else {
			console.warn(`During unsubscribe request initiation attempt track ${track} not found in trackToIDMap.`)
		}
	}

	recvSubscribeOk(msg: Control.SubscribeOk) {
		const subscribe = this.#subscribe.get(msg.id)
		if (!subscribe) {
			throw new Error(`subscribe ok for unknown id: ${msg.id}`)
		}

		// Store the track alias provided by the publisher
		this.#trackAliasMap.set(msg.id, msg.track_alias)
		// Also create reverse mapping for receiving objects
		this.#aliasToSubscriptionMap.set(msg.track_alias, msg.id)
		const callback = this.#pendingTrack.get(msg.track_alias)
		if (callback) {
			this.#pendingTrack.delete(msg.track_alias)
			callback(msg.id)
		}

		console.log("subscribe ok", msg)
		subscribe.onOk(msg.track_alias)
	}

	async recvSubscribeError(msg: Control.SubscribeError) {
		const subscribe = this.#subscribe.get(msg.id)
		if (!subscribe) {
			throw new Error(`subscribe error for unknown id: ${msg.id}`)
		}

		await subscribe.onError(msg.code, msg.reason)
	}

	async recvPublishDone(msg: Control.PublishDone) {
		const subscribe = this.#subscribe.get(msg.id)
		if (!subscribe) {
			throw new Error(`publish done for unknown id: ${msg.id}`)
		}

		await subscribe.onDone(msg.code, msg.stream_count, msg.reason)
	}

	// Called by connection with pre-read data (QUIC stream already closed)
	recvData(data: SubgroupData) {
		const track_alias = data.header.track_alias
		const subscriptionId = this.#aliasToSubscriptionMap.get(track_alias)
		const dispatch = (id: bigint) => {
			const subscribe = this.#subscribe.get(id)
			if (!subscribe) {
				console.warn(`[SUBSCRIBER] data for unknown subscription: ${id}`)
				return
			}
			subscribe.onSubgroupData(data)
		}
		if (subscriptionId === undefined) {
			// Buffer the first data for this alias until SUBSCRIBE_OK arrives
			const prev = this.#pendingTrack.get(track_alias)
			if (prev) {
				// Already have pending — drop this one (it's just data, no stream to leak)
				return
			}
			console.warn(`[SUBSCRIBER] buffering data for unknown alias ${track_alias} until SUBSCRIBE_OK`)
			this.#pendingTrack.set(track_alias, (id: bigint) => {
				dispatch(id)
				return Promise.resolve()
			})
			return
		}

		dispatch(subscriptionId)
	}

	// Legacy method kept for compatibility — but connection now uses recvData() instead
	recvObject(reader: TrackReader | SubgroupReader) {
		reader.close().catch(() => {})
	}
}

export class PublishNamespaceRecv {
	#control: ControlStream
	#id: bigint

	readonly namespace: string[]

	// The current state of the publish namespace
	#state: "init" | "ack" | "closed" = "init"

	constructor(control: ControlStream, namespace: string[], id: bigint) {
		this.#control = control // so we can send messages
		this.namespace = namespace
		this.#id = id
	}

	// Acknowledge the publish namespace as valid.
	async ok() {
		if (this.#state !== "init") return
		this.#state = "ack"

		// Send the control message.
		return this.#control.send({
			type: Control.ControlMessageType.PublishNamespaceOk,
			message: { id: this.#id }
		})
	}

	async close(code = 0n, reason = "") {
		if (this.#state === "closed") return
		this.#state = "closed"

		return this.#control.send({
			type: Control.ControlMessageType.PublishNamespaceError,
			message: { id: this.#id, code, reason }
		})
	}
}

export class SubscribeSend {
	#control: ControlStream
	#id: bigint
	#trackAlias?: bigint // Set when SUBSCRIBE_OK is received

	readonly namespace: string[]
	readonly track: string

	// Queue holds pre-read data (NOT open stream handles).
	// This prevents MAX_STREAMS exhaustion — QUIC streams are read and closed
	// immediately in onData(), never buffered open.
	#data = new Queue<SubgroupData>(16)

	constructor(control: ControlStream, id: bigint, namespace: string[], track: string) {
		this.#control = control // so we can send messages
		this.#id = id
		this.namespace = namespace
		this.track = track
	}

	get trackAlias(): bigint | undefined {
		return this.#trackAlias
	}

	async close(_code = 0n, _reason = "") {
		await this.#data.close()
	}

	onOk(trackAlias: bigint) {
		console.warn(`[SUBSCRIBER] track alias set: ${trackAlias}`)
		this.#trackAlias = trackAlias
	}

	async onDone(code: bigint, _streamCount: bigint, reason: string) {
		console.log(`PUBLISH_DONE received: code=${code}, reason=${reason}`)
		return await this.#data.close()
	}

	async onError(code: bigint, reason: string) {
		if (code == 0n) {
			return await this.#data.close()
		}

		if (reason !== "") {
			reason = `: ${reason}`
		}

		const err = new Error(`SUBSCRIBE_ERROR (${code})${reason}`)
		return await this.#data.abort(err)
	}

	// Serialized push chain for queuing pre-read data
	#pushChain: Promise<void> = Promise.resolve()

	// Called with pre-read data (QUIC stream already closed by connection loop)
	onSubgroupData(subData: SubgroupData) {
		this.#pushChain = this.#pushChain.then(async () => {
			if (!this.#data.closed()) {
				await this.#data.push(subData)
			}
		}).catch((e) => {
			console.warn("Failed to push data to subscription queue:", e)
		})
	}

	// Receive the next pre-read subgroup data
	async data(): Promise<SubgroupData | undefined> {
		return await this.#data.next()
	}
}
