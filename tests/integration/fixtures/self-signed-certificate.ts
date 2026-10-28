import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Creates a one-day self-signed certificate for `localhost` with `openssl`, as
 * Nest `httpsOptions`.
 */
export function createSelfSignedCertificate() {
	const directory = mkdtempSync(join(tmpdir(), 'platform-hono-tls-'))
	const keyPath = join(directory, 'key.pem')
	const certPath = join(directory, 'cert.pem')
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-subj',
			'/CN=localhost',
			'-days',
			'1',
		],
		{ stdio: 'ignore' }
	)
	const certificate = {
		cert: readFileSync(certPath, 'utf8'),
		key: readFileSync(keyPath, 'utf8'),
	}
	rmSync(directory, { force: true, recursive: true })
	return certificate
}
