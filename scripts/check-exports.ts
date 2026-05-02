const mod = await import('../dist/index.js')

if (typeof mod.HonoAdapter !== 'function') {
	throw new Error('HonoAdapter export missing')
}

export {}
