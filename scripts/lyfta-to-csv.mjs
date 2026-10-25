#!/usr/bin/env node
// Lyfta workouts (JSON, as the Lyfta MCP connector's get_workout returns them) -> a CSV for
// Settings -> Data & backup -> Import from another app. The logic and its tests live in
// frontend/src/lib/import-lyfta.js; this is only the command line around it.
//
//   node scripts/lyfta-to-csv.mjs workouts.json --out lyfta.csv [--tz Europe/Rome] [--names names.json]
//
// names.json renames exercises created in Lyfta under a name the catalogue cannot reach:
//   { "Pushdown Ai Cavi Unilaterale": "cable one arm tricep pushdown" }
// Every inference (warm-ups, copied weights, dropped sets) is listed on stderr.

import fs from 'node:fs'
import { lyftaToCSV, WARMUP_RATIO } from '../frontend/src/lib/import-lyfta.js'

const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v }
const outFile = flag('--out', null)
const tz = flag('--tz', 'Europe/Rome')
const namesFile = flag('--names', null)
if (!args[0]) { console.error('usage: lyfta-to-csv.mjs <workouts.json> [--out file.csv] [--tz Europe/Rome] [--names names.json]'); process.exit(2) }

const workouts = JSON.parse(fs.readFileSync(args[0], 'utf8'))
const names = namesFile ? JSON.parse(fs.readFileSync(namesFile, 'utf8')) : {}
const { csv, report } = lyftaToCSV(workouts, { tz, names })
if (outFile) fs.writeFileSync(outFile, csv); else process.stdout.write(csv)

const log = (t, list) => { if (list.length) console.error(`\n${t} (${list.length}):\n  ` + list.join('\n  ')) }
console.error(`${report.workouts} workouts, ${report.sets} sets (${tz}).`)
log('Renamed', report.renamed)
log(`Warm-ups (leading sets under ${WARMUP_RATIO * 100}% of the top set)`, report.warmups)
log('Weights copied from the previous set', report.carried)
log('Sets left out', report.dropped)
log('Workouts left out', report.skipped)
