export function validateMigrationHistory<T extends { tag: string; when: number; sql: string }>(migrations: T[], applied: { created_at: string | number | null; hash: string }[]): T[];
