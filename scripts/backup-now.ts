import 'dotenv/config';
import { performBackup } from '../src/jobs/backup.job.js';

await performBackup();
