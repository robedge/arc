import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DbHandle } from '../client'
import { appSettings } from '../schema'
import {
  agentLoadOffSchema,
  modelRefSchema,
  voiceEndPauseMsSchema,
  voiceIdSchema,
  voiceSpeakPolicySchema,
  voiceSpeedSchema,
  workersPrefSchema
} from '../../../shared/provider-schemas'
import type { AppSettings, ModelRef, ProviderId, WorkersPref } from '../../../shared/types/provider'

/** Known settings keys and the schema of each value. */
export const appSettingSchemas = {
  'providers.brain': modelRefSchema,
  'providers.workers': workersPrefSchema,
  'usage.checkClaudePlanOnLaunch': z.boolean(),
  'knowledge.suggestOnFinish': z.boolean(),
  'approvals.skipAllByDefault': z.boolean(),
  'agents.loadOff': agentLoadOffSchema,
  'voice.voiceId': voiceIdSchema,
  'voice.speed': voiceSpeedSchema,
  'voice.speakPolicy': voiceSpeakPolicySchema,
  'voice.muted': z.boolean(),
  'voice.endPauseMs': voiceEndPauseMsSchema
} as const

export type AppSettingKey = keyof typeof appSettingSchemas
export type AppSettingValues = AppSettings

export const appSettingDefaults: AppSettingValues = {
  'providers.brain': { provider: 'claude', model: 'sonnet' },
  'providers.workers': { mode: 'auto' },
  'usage.checkClaudePlanOnLaunch': true,
  'knowledge.suggestOnFinish': true,
  'approvals.skipAllByDefault': false,
  'agents.loadOff': { brain: [], workers: [] },
  'voice.voiceId': 'af_heart',
  'voice.speed': 1,
  'voice.speakPolicy': 'all',
  'voice.muted': false,
  'voice.endPauseMs': 1000
}

export interface ProviderDefaults {
  brain: ModelRef
  workers: WorkersPref
}

function dismissedKey(provider: ProviderId): string {
  return `providers.update_dismissed.${provider}`
}

/** Key-value app settings. A missing or unreadable row means the default. */
export class AppSettingsRepo {
  constructor(private readonly db: DbHandle) {}

  /** The validated value, or the default when the row is missing or invalid. */
  get<K extends AppSettingKey>(key: K): AppSettingValues[K] {
    const row = this.db.select().from(appSettings).where(eq(appSettings.key, key)).get()
    if (row) {
      try {
        const parsed = appSettingSchemas[key].safeParse(JSON.parse(row.valueJson))
        if (parsed.success) return parsed.data as AppSettingValues[K]
      } catch {
        // Unparseable JSON: fall through to the default.
      }
    }
    return appSettingDefaults[key]
  }

  /** Validates, then upserts. Throws a ZodError on an invalid value. */
  set<K extends AppSettingKey>(key: K, value: AppSettingValues[K], now: number): void {
    this.write(this.db, key, value, now)
  }

  /** Several keys in one transaction; an invalid value changes none of them. */
  setMany(entries: Partial<AppSettingValues>, now: number): void {
    const pairs = (Object.keys(entries) as AppSettingKey[]).map(
      (key) => [key, appSettingSchemas[key].parse(entries[key])] as const
    )
    this.db.transaction((tx) => {
      for (const [key, value] of pairs) this.write(tx, key, value, now)
    })
  }

  /** Every known key, for `settings:get`. */
  getAll(): AppSettings {
    return {
      'providers.brain': this.get('providers.brain'),
      'providers.workers': this.get('providers.workers'),
      'usage.checkClaudePlanOnLaunch': this.get('usage.checkClaudePlanOnLaunch'),
      'knowledge.suggestOnFinish': this.get('knowledge.suggestOnFinish'),
      'approvals.skipAllByDefault': this.get('approvals.skipAllByDefault'),
      'agents.loadOff': this.get('agents.loadOff'),
      'voice.voiceId': this.get('voice.voiceId'),
      'voice.speed': this.get('voice.speed'),
      'voice.speakPolicy': this.get('voice.speakPolicy'),
      'voice.muted': this.get('voice.muted'),
      'voice.endPauseMs': this.get('voice.endPauseMs')
    }
  }

  /**
   * `providers.update_dismissed.<provider>`: the version whose update notice the user dismissed.
   * Kept outside `AppSettings` (the Settings pickers never read it).
   */
  getDismissedUpdate(provider: ProviderId): string | undefined {
    const row = this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, dismissedKey(provider)))
      .get()
    if (!row) return undefined
    try {
      const parsed = z.string().min(1).safeParse(JSON.parse(row.valueJson))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  setDismissedUpdate(provider: ProviderId, version: string, now: number): void {
    const valueJson = JSON.stringify(z.string().min(1).parse(version))
    this.db
      .insert(appSettings)
      .values({ key: dismissedKey(provider), valueJson, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: now } })
      .run()
  }

  getProviderDefaults(): ProviderDefaults {
    return { brain: this.get('providers.brain'), workers: this.get('providers.workers') }
  }

  private write(h: DbHandle, key: AppSettingKey, value: unknown, now: number): void {
    const valueJson = JSON.stringify(appSettingSchemas[key].parse(value))
    h.insert(appSettings)
      .values({ key, valueJson, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { valueJson, updatedAt: now } })
      .run()
  }
}
