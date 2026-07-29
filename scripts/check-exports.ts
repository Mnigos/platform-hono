import { execFileSync } from 'node:child_process'
import {
	accessSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PackFile {
	path: string
}

interface PackResult {
	filename: string
	files: PackFile[]
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'platform-hono-consumer-'))

try {
	const npmCache = join(temporaryRoot, 'npm-cache')
	const packDirectory = join(temporaryRoot, 'pack')
	const consumerDirectory = join(temporaryRoot, 'consumer')

	mkdirSync(packDirectory)
	mkdirSync(consumerDirectory)

	const packOutput = execFileSync(
		'npm',
		[
			'pack',
			'--json',
			'--ignore-scripts',
			'--pack-destination',
			packDirectory,
			'--cache',
			npmCache,
		],
		{ cwd: packageRoot, encoding: 'utf8' }
	)
	const [packResult] = JSON.parse(packOutput) as PackResult[]

	if (!packResult) throw new Error('npm pack did not produce an artifact')

	const packedFiles = new Set(packResult.files.map(file => file.path))
	for (const requiredFile of ['dist/index.d.ts', 'dist/index.js']) {
		if (!packedFiles.has(requiredFile))
			throw new Error(`Packed package is missing ${requiredFile}`)
	}

	const tarballPath = join(packDirectory, packResult.filename)

	writeFileSync(
		join(consumerDirectory, 'package.json'),
		JSON.stringify({ name: 'package-consumer', private: true, type: 'module' })
	)
	writeFileSync(
		join(consumerDirectory, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				noEmitOnError: true,
				outDir: 'dist',
				rootDir: '.',
				strict: true,
				target: 'ES2022',
				types: ['node'],
			},
			include: ['consumer.ts'],
		})
	)
	writeFileSync(
		join(consumerDirectory, 'consumer.ts'),
		`import {
	HonoAdapter,
	type HonoAdapterOptions,
	type NestHonoRequest,
} from '@mnigos/platform-hono'

const options: HonoAdapterOptions = {}
const request = {} as NestHonoRequest
const adapter = new HonoAdapter(options)

if (adapter.getType() !== 'hono' || request.rawBody !== undefined)
	throw new Error('Packed package exports are invalid')

adapter.get((_request, context) => {
	adapter.reply(context, { ok: true })
})

const response = await adapter.hono.request('/')
if (response.bodyUsed || JSON.stringify(await response.json()) !== '{"ok":true}')
	throw new Error('Packed adapter returned an invalid response')
`
	)

	execFileSync(
		'npm',
		[
			'install',
			'--ignore-scripts',
			'--no-package-lock',
			'--no-audit',
			'--no-fund',
			'--cache',
			npmCache,
			tarballPath,
			'@types/node@latest',
		],
		{ cwd: consumerDirectory, stdio: 'inherit' }
	)

	const installedPackage = join(
		consumerDirectory,
		'node_modules',
		'@mnigos',
		'platform-hono'
	)
	accessSync(join(installedPackage, 'dist/index.d.ts'))
	accessSync(join(installedPackage, 'dist/index.js'))

	execFileSync(
		process.execPath,
		[
			join(packageRoot, 'node_modules/typescript/bin/tsc'),
			'--project',
			join(consumerDirectory, 'tsconfig.json'),
		],
		{ cwd: consumerDirectory, stdio: 'inherit' }
	)
	execFileSync('node', [join(consumerDirectory, 'dist/consumer.js')], {
		cwd: consumerDirectory,
		stdio: 'inherit',
	})
	execFileSync(
		process.execPath,
		[join(consumerDirectory, 'dist/consumer.js')],
		{
			cwd: consumerDirectory,
			stdio: 'inherit',
		}
	)
} finally {
	rmSync(temporaryRoot, { force: true, recursive: true })
}
