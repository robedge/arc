/** Trims and NFC-normalizes a group name as typed by the user. */
export function normalizeGroupName(raw: string): string {
  return raw.trim().normalize('NFC')
}

/** Case-insensitive uniqueness key: trim, NFC, then lowercase (folds non-ASCII too). */
export function groupNameKey(raw: string): string {
  return normalizeGroupName(raw).toLowerCase()
}
