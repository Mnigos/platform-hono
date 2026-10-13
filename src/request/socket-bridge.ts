import { EventEmitter } from 'node:events'

type Listener = (...args: unknown[]) => void

export interface NodeSocketLike {
	on: (event: string, listener: Listener) => unknown
	once: (event: string, listener: Listener) => unknown
	removeListener: (event: string, listener: Listener) => unknown
	[key: PropertyKey]: unknown
}

export interface RequestSocketBridge {
	signalClose: () => void
	socket: NodeSocketLike
}

/**
 * Wraps a keep-alive Node.js socket so per-request `close` listeners are
 * released after the response instead of piling up on the shared socket.
 */
export function createRequestSocketBridge(socket: NodeSocketLike) {
	const closeEvents = new EventEmitter()
	let listening = false
	let bridgedSocket: NodeSocketLike
	const forwardClose = (...args: unknown[]) => {
		listening = false
		closeEvents.emit('close', ...args)
	}
	const listen = () => {
		if (listening) return
		listening = true
		socket.once('close', forwardClose)
	}
	const stopListening = () => {
		if (!listening) return
		listening = false
		socket.removeListener('close', forwardClose)
	}
	const addCloseListener = (method: 'on' | 'once', listener: Listener) => {
		listen()
		closeEvents[method]('close', listener)
		return bridgedSocket
	}
	const removeCloseListener = (listener: Listener) => {
		closeEvents.removeListener('close', listener)
		if (closeEvents.listenerCount('close') === 0) stopListening()
		return bridgedSocket
	}

	bridgedSocket = new Proxy(socket, {
		get(target, property) {
			if (property === 'on' || property === 'addListener') {
				return (event: string, listener: Listener) => {
					if (event === 'close') return addCloseListener('on', listener)
					socket.on(event, listener)
					return bridgedSocket
				}
			}
			if (property === 'once') {
				return (event: string, listener: Listener) => {
					if (event === 'close') return addCloseListener('once', listener)
					socket.once(event, listener)
					return bridgedSocket
				}
			}
			if (property === 'off' || property === 'removeListener') {
				return (event: string, listener: Listener) => {
					if (event === 'close') return removeCloseListener(listener)
					socket.removeListener(event, listener)
					return bridgedSocket
				}
			}

			const socketValue = Reflect.get(target, property, target)
			return typeof socketValue === 'function'
				? socketValue.bind(target)
				: socketValue
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target)
		},
	})

	return {
		signalClose() {
			stopListening()
			closeEvents.emit('close')
		},
		socket: bridgedSocket,
	}
}
