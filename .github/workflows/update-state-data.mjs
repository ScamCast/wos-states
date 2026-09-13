import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = 'https://gof-gm-api-formal.centurygame.com/api/kingdom/status?env=prod&language=en';
const stateDataPath = new URL('../../state_data.json', import.meta.url);

async function main() {
  const args = process.argv.slice(2);
  let inputFile;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--file' && args[i + 1] && !args[i + 1].startsWith('--')) {
      inputFile = args[++i];
    } else {
      throw new Error('Usage: node .github/workflows/update-state-data.mjs [--file opening-dates.json] [--dry-run]');
    }
  }

  let payload;
  if (inputFile) {
    payload = JSON.parse(await readFile(inputFile, 'utf8'));
  } else {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`State API returned HTTP ${response.status}.`);
    payload = await response.json();
    if (payload?.code !== 1) throw new Error('State API did not report success.');
  }

  if (payload && Object.hasOwn(payload, 'code') && payload.code !== 1) {
    throw new Error('The input contains an unsuccessful API response.');
  }
  const dates = payload && Object.hasOwn(payload, 'open_time') ? payload.open_time : payload;
  if (!dates || typeof dates !== 'object' || Array.isArray(dates)) {
    throw new Error('Expected an open_time map or a state-to-Unix-seconds JSON object.');
  }

  const verifiedDates = {};
  const latestAllowedTime = Math.floor(Date.now() / 1000) + 86400;
  for (const [state, value] of Object.entries(dates)) {
    const timestamp = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
      ? Number(value) : NaN;
    if (!/^[1-9]\d*$/.test(state) || !Number.isSafeInteger(Number(state)) ||
        !Number.isSafeInteger(timestamp) || timestamp < 1610323200 || timestamp > latestAllowedTime) {
      throw new Error(`Invalid state opening timestamp for state ${state}; no data was written.`);
    }
    verifiedDates[state] = timestamp;
  }

  const existing = JSON.parse(await readFile(stateDataPath, 'utf8'));
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('state_data.json must contain a state-to-Unix-seconds JSON object.');
  }
  for (const [state, timestamp] of Object.entries(existing)) {
    if (!/^[1-9]\d*$/.test(state) || !Number.isSafeInteger(Number(state)) ||
        !Number.isSafeInteger(timestamp) || timestamp < 1610323200 || timestamp > latestAllowedTime) {
      throw new Error(`Invalid existing timestamp for state ${state}; no data was written.`);
    }
  }
  const added = Object.keys(verifiedDates).filter(state => !Object.hasOwn(existing, state));
  const conflicts = Object.keys(verifiedDates).filter(state =>
    Object.hasOwn(existing, state) && existing[state] !== verifiedDates[state]);
  const merged = { ...verifiedDates, ...existing };

  if (!dryRun && added.length) {
    await writeFile(stateDataPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  }

  console.log(`${dryRun ? 'Dry run' : 'Update'}: ${Object.keys(verifiedDates).length} dates received, ` +
    `${added.length} added, ${conflicts.length} conflicting dates ignored, ${Object.keys(merged).length} total states.`);
  if (added.length) console.log(`New states: ${added.sort((a, b) => Number(a) - Number(b)).join(', ')}`);
  console.log(inputFile ? `Source: ${inputFile}` : `Source: ${sourceUrl}`);
  console.log('Missing states are preserved; the public feed does not provide a complete historical list.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
