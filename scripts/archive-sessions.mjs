#!/usr/bin/env node
/**
 * List or archive worker and reviewer Sessions idle past a retention window, through the Host's own durable archive set.
 *
 * A dry run is the default: nothing is written unless `--apply` asks for it, and archiving never deletes or moves a
 * Session's files — it hides the Session and blocks its next step, as the Session list's own Archive action does.
 */
import { parseArgs } from 'node:util'

const USAGE = `Usage: node scripts/archive-sessions.mjs [options]

Lists worker/reviewer Sessions whose newest transcript is older than --days (default 7).
Without --apply it only reports them. Archiving keeps every file; it never deletes.

Options:
  --url <url>    DeepSeek Harness web address (default: $DSH_SUPERAGENT_URL, $DSH_WEB_URL, or http://127.0.0.1:3082)
  --days <n>     Retention window in days (default: 7; the Host's automatic pass uses 7)
  --apply        Archive the listed Sessions; without it the run is a dry run
  --json         Print the Host's report as JSON
  -h, --help     Show this text
`

let values
try {
  ({ values } = parseArgs({ options: {
    url: { type: 'string' }, days: { type: 'string' }, apply: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  } }))
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
  process.exit(2)
}
if (values.help) { console.log(USAGE); process.exit(0) }

const base = (values.url ?? process.env.DSH_SUPERAGENT_URL ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3082').replace(/\/+$/, '')
const days = values.days === undefined ? undefined : Number(values.days)
if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
  console.error('--days must be a positive integer')
  process.exit(2)
}
const dryRun = !values.apply
const endpoint = `${base}/orchestrator/api/sessions/archive`

let response
try {
  response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
    body: JSON.stringify(days === undefined ? { dryRun } : { days, dryRun }) })
} catch (error) {
  console.error(`Could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
  console.error('Start the Host, or pass --url with the DeepSeek Harness web address (the log prints it; the desktop profile often uses http://127.0.0.1:61890).')
  process.exit(1)
}
const text = await response.text()
if (!response.ok) {
  console.error(`The Host refused the request (${response.status}): ${text}`)
  process.exit(1)
}
let report
try { report = JSON.parse(text) } catch {
  console.error(`The Host answered with something that is not JSON: ${text}`)
  process.exit(1)
}
if (report === null || typeof report !== 'object' || Array.isArray(report)) {
  console.error(`The Host answered with an unexpected report: ${text}`)
  process.exit(1)
}

if (values.json) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.failed?.length ? 1 : 0)
}
if (!report.available) {
  console.error('This Host does not expose the durable Session archive set, so it cannot archive Sessions.')
  process.exit(1)
}

const mode = report.dryRun ? 'dry run' : 'apply'
console.log(`Session archive · ${mode} · idle > ${report.days} days · ${report.scanned} stored Session(s) at ${base}`)
if (report.candidates.length === 0) {
  console.log(`No worker or reviewer Session is idle longer than ${report.days} days.`)
} else {
  const width = Math.max(39, ...report.candidates.map(item => item.sessionId.length))
  console.log(`${'SESSION'.padEnd(width)}  ${'ROLE'.padEnd(8)}  ${'TICKET'.padEnd(32)}  ${'LAST ACTIVE'.padEnd(10)}  AGE`)
  for (const item of report.candidates) {
    console.log(`${item.sessionId.padEnd(width)}  ${item.role.padEnd(8)}  ${item.ticketId.padEnd(32)}  ${item.lastActive.slice(0, 10)}  ${item.ageDays}d`)
  }
}
const { skipped, archived, failed } = report
if (report.createdFallback > 0) {
  console.log(`\nNote: ${report.createdFallback} candidate(s) had no readable transcript, so their creation time decided their age.`)
}
if (report.dryRun) {
  console.log(`Skipped ${skipped.recent} recent, ${skipped.liveTicket} with a live Ticket, ${skipped.archived} already archived, ${skipped.active.length} active.`)
  console.log(`\nDry run: ${report.candidates.length} Session(s) would be archived; no files were changed.`)
  console.log('Re-run with --apply to archive them. Archiving keeps their files; unarchive them from the Session list.')
} else {
  console.log(`\nArchived ${archived.length} Session(s); their files are kept.`)
  console.log(`Skipped ${skipped.recent} recent, ${skipped.liveTicket} with a live Ticket, ${skipped.archived} already archived, ${skipped.active.length} active.`)
  if (skipped.active.length > 0) console.log(`Active Sessions are retried on the next pass: ${skipped.active.join(', ')}`)
  if (failed.length > 0) for (const item of failed) console.error(`Failed ${item.sessionId}: ${item.error}`)
}
process.exit(failed.length > 0 ? 1 : 0)
