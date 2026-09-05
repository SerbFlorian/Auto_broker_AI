import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Portable scraper resume state (page windows / country index).
 * Prefer SCRAPER_STATE_DIR or /app/data (Docker volume); fall back to cwd/data.
 */
function resolveStatePath(): string {
  if (process.env.SCRAPER_STATE_DIR) {
    return path.join(process.env.SCRAPER_STATE_DIR, 'scraper_states.json');
  }
  if (process.env.SCRAPER_STATE_FILE) {
    return process.env.SCRAPER_STATE_FILE;
  }
  // Docker image writes here (volume scraper_state → /app/data)
  const dockerData = '/app/data/scraper_states.json';
  try {
    // sync existence check avoided — always prefer /app/data when WORKDIR is /app
    if (process.cwd() === '/app') return dockerData;
  } catch {
    /* ignore */
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'data', 'scraper_states.json');
}

const STATE_FILE_PATH = resolveStatePath();

interface ScraperStates {
  [scraperId: string]: {
    stateData: unknown;
    lastUpdated: string;
  };
}

async function readStateFile(): Promise<ScraperStates> {
  try {
    await fs.access(STATE_FILE_PATH);
    const fileContent = await fs.readFile(STATE_FILE_PATH, 'utf-8');
    return JSON.parse(fileContent) as ScraperStates;
  } catch {
    return {};
  }
}

async function writeStateFile(states: ScraperStates): Promise<void> {
  try {
    const directory = path.dirname(STATE_FILE_PATH);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(STATE_FILE_PATH, JSON.stringify(states, null, 2), 'utf-8');
  } catch (error) {
    console.error('❌ Could not write scraper state file:', error);
  }
}

export async function getState<T>(scraperId: string): Promise<T | null> {
  const states = await readStateFile();
  return (states[scraperId]?.stateData as T) || null;
}

export async function setState<T>(scraperId: string, stateData: T | null): Promise<void> {
  const states = await readStateFile();
  states[scraperId] = {
    stateData,
    lastUpdated: new Date().toISOString()
  };
  await writeStateFile(states);
}

export function getScraperStateFilePath(): string {
  return STATE_FILE_PATH;
}
