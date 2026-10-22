import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Key-value app settings; `value_json` is JSON. A missing row means the default. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull()
})
