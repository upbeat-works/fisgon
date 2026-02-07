import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import  { type FisgonConfig } from '../core/types.js'

const CONFIG_FILES = ['fisgon.config.ts', 'fisgon.config.js', 'fisgon.config.mjs']

export async function loadConfig(cwd = process.cwd()): Promise<FisgonConfig | null> {
  for (const file of CONFIG_FILES) {
    const fullPath = resolve(cwd, file)
    if (existsSync(fullPath)) {
      try {
        const mod = await import(pathToFileURL(fullPath).href)
        return mod.default ?? mod
      } catch {
        // Try next
      }
    }
  }
  return null
}
