#!/usr/bin/env node

// @ts-ignore
import * as path from 'node:path';
// @ts-ignore
import * as fs from 'node:fs/promises';
// @ts-ignore
import { fileURLToPath } from 'node:url';
// @ts-ignore
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import type { MigrationResultSet } from 'kysely/migration';

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
  exitCode?: number;
};

const { Pool } = pg;

export type MigrationCommand = 'latest' | 'up' | 'down';

export interface RunMigratorOptions {
  command?: MigrationCommand;
  databaseUrl?: string;
  migrationFolder?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrator(options: RunMigratorOptions = {}): Promise<MigrationResultSet> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const command = options.command ?? 'latest';
  if (command !== 'latest' && command !== 'up' && command !== 'down') {
    throw new Error(`Unknown migration command "${command}". Supported commands: latest, up, down`);
  }

  const migrationFolder = options.migrationFolder ?? path.join(__dirname, 'migrations');
  if (typeof (fs as any).mkdir === 'function') {
    await (fs as any).mkdir(migrationFolder, { recursive: true });
  }

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
      }) as any,
    }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
    }),
  });

  try {
    let resultSet: MigrationResultSet;
    switch (command) {
      case 'latest':
        console.log('Running migrations to latest...');
        resultSet = await migrator.migrateToLatest();
        break;
      case 'up':
        console.log('Running next migration up...');
        resultSet = await migrator.migrateUp();
        break;
      case 'down':
        console.log('Rolling back last migration...');
        resultSet = await migrator.migrateDown();
        break;
    }

    const { error, results } = resultSet;

    if (results && results.length > 0) {
      for (const it of results) {
        if (it.status === 'Success') {
          console.log(`Migration "${it.migrationName}" (${it.direction}): Success`);
        } else if (it.status === 'Error') {
          console.error(`Migration "${it.migrationName}" (${it.direction}): Failed`);
        } else if (it.status === 'NotExecuted') {
          console.warn(`Migration "${it.migrationName}" (${it.direction}): Not executed`);
        }
      }
    } else if (!error) {
      console.log('No migrations to execute.');
    }

    if (error) {
      console.error('Migration failed:', error);
    } else {
      console.log('Migration completed successfully.');
    }

    return resultSet;
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    console.log('Usage: migrator [latest|up|down]');
    console.log('Commands:');
    console.log('  latest  Run all pending migrations (default)');
    console.log('  up      Run the next pending migration');
    console.log('  down    Rollback the last executed migration');
    process.exit(0);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const command = args[0] ?? 'latest';
  if (command !== 'latest' && command !== 'up' && command !== 'down') {
    console.error(`Error: Unknown migration command "${command}". Supported commands: latest, up, down`);
    process.exit(1);
  }

  try {
    const result = await runMigrator({
      command,
      databaseUrl,
    });

    if (result.error) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
};

if (isMainModule()) {
  main().catch((err) => {
    console.error('Migration execution failed:', err);
    process.exit(1);
  });
}
