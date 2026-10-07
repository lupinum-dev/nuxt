import { describe, expect, it } from 'vitest'
import { join, resolve } from 'pathe'
import { loadNuxt, writeTypes } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { resolveModulePath } from 'exsolve'
import type { Nitro, NitroConfig } from 'nitropack/types'

const fixtureDir = resolve(import.meta.dirname, '../../../test/fixtures/minimal')

const serverReplacements = {
  '__VUE_PROD_DEVTOOLS__': 'false',
  'import.meta.test': 'false',
}

async function withNitro<T> (fn: (nitro: Nitro, nitroConfig: NitroConfig, nuxt: Nuxt) => T | Promise<T>, compatibilityVersion: 4 | 5 = 4) {
  let nitroConfig: NitroConfig | undefined
  let nitro: Nitro | undefined
  const nuxt = await loadNuxt({
    cwd: fixtureDir,
    ready: true,
    overrides: {
      future: { compatibilityVersion },
      hooks: {
        'nitro:config' (config) {
          nitroConfig = config
        },
        'nitro:init' (_nitro) {
          nitro = _nitro
        },
      },
    },
  })
  try {
    return await fn(nitro!, nitroConfig!, nuxt)
  } finally {
    await nuxt.close()
  }
}

describe('nitro config', () => {
  // Authored by a Codex agent; not yet reviewed by a human.
  it('preserves Nitro config types under compatibility 5 NodeNext resolution', { timeout: 60_000 }, async () => {
    await withNitro(async (_nitro, _nitroConfig, nuxt) => {
      const root = await mkdtemp(join(tmpdir(), 'nuxt-nitro-config-types-'))
      const consumer = join(root, 'config.mts')
      try {
        await writeTypes(nuxt)
        await writeFile(consumer, `
          import type {} from ${JSON.stringify(resolve(import.meta.dirname, '../src/augments.ts'))}
          import type { NitroConfig } from 'nitropack/types'
          const config: NitroConfig = { prerender: { routes: ['/'] } }
          config.alias = { '#probe': './probe' }
        `)
        // Nuxt's local dependency patch repairs this entry, but published consumers
        // receive Nitro's extensionless export. Use its real declarations with that entry.
        const packageDir = resolveModulePath('nitropack/package.json', { from: [import.meta.url] }).replace(/\/package\.json$/, '')
        const releasedNitro = join(root, 'nitropack')
        await mkdir(join(releasedNitro, 'dist'), { recursive: true })
        await cp(join(packageDir, 'package.json'), join(releasedNitro, 'package.json'))
        await cp(join(packageDir, 'dist/types'), join(releasedNitro, 'dist/types'), { recursive: true })
        await cp(join(packageDir, 'dist/shared'), join(releasedNitro, 'dist/shared'), { recursive: true })
        await writeFile(join(releasedNitro, 'types.d.ts'), 'export * from "./dist/types/index";\n')
        const config = JSON.parse(await readFile(join(nuxt.options.buildDir, 'tsconfig.node.json'), 'utf8'))
        config.compilerOptions.paths['nitropack/types'] = config.compilerOptions.paths['nitropack/types'].map((path: string) =>
          resolve(nuxt.options.buildDir, path).replace(packageDir, releasedNitro),
        )
        const parsed = ts.parseJsonConfigFileContent({ ...config, files: [consumer], include: [], exclude: [] }, ts.sys, nuxt.options.buildDir)
        const program = ts.createProgram([consumer], { ...parsed.options, types: [], noEmit: true })
        const diagnostics = program.getSemanticDiagnostics(program.getSourceFile(consumer))
        expect(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 5)
  })

  it('passes the server replacements to nitro as `replace`', async () => {
    await withNitro((_nitro, nitroConfig) => {
      expect(nitroConfig.replace).toMatchObject(serverReplacements)
    })
  })

  it('passes the server replacements to the prerenderer', async () => {
    await withNitro(async (nitro) => {
      // nitro creates the prerenderer from a copy of this config
      const prerendererConfig: NitroConfig = { ...nitro.options._config }
      await nitro.hooks.callHook('prerender:config', prerendererConfig)
      expect(prerendererConfig.replace).toMatchObject(serverReplacements)
    })
  })

  it('does not include the dev error channel in production builds', async () => {
    await withNitro((_nitro, nitroConfig) => {
      const errorChannel = nitroConfig.virtual!['#internal/nuxt/error-channel'] as () => string
      expect(errorChannel()).toBe('export {}')
    })
  })
})
