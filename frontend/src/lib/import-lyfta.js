// Lyfta -> the CSV that "Import from another app" reads (import-csv.js).
//
// Lyfta's read-only MCP connector returns each workout as
//   { workoutId, title, performedAt: "YYYY-MM-DD HH:MM:SS" (UTC), exercises: [{ name, sets: [{ weight, reps, rir }] }] }
// with no set type, and now and then a set with reps but no weight. This turns that into rows
// the importer already understands, so Lyfta needs no second importer: one row per set, the
// session's local start time, the set type and the effort.
//
// Two things Lyfta does not record are inferred, by fixed rules, and every decision is
// returned in `report` so it can be shown before anything is imported:
//   - Warm-ups: the leading sets of a loaded exercise that sit below WARMUP_RATIO of its
//     heaviest set. A dip or a pull-up is never touched: its weight is the added load, and
//     5 kg on a dip is a working set, not 10 % of one.
//   - A missing weight on a loaded exercise: the set before it is copied and a note says so.
//     With nothing before it the set is left out, because guessing a load would put a number
//     in the history that was never lifted. On a bodyweight exercise no weight means bodyweight.
//
// `names` renames exercises on the way through, for the ones a user created in Lyfta under a
// name the catalogue cannot reach ("Pushdown Ai Cavi Unilaterale"): map it to the catalogue's
// own name and the importer matches it exactly.

export const WARMUP_RATIO = 0.7
const BODYWEIGHT = /\b(dips?|pull[- ]?ups?|chin[- ]?ups?|push[- ]?ups?|muscle[- ]?ups?)\b/i

export const LYFTA_HEADER = ['Workout Name', 'Date', 'Exercise', 'Weight kg', 'Reps', 'RIR', 'Set Type', 'Notes']
export const CARRIED_NOTE = 'weight missing in Lyfta, copied from the previous set'

const clean = s => String(s || '').replace(/\s+/g, ' ').trim()

/** "2026-10-12 16:26:05" (UTC) -> "2026-10-12 18:26" in `tz`. Throws on an unreadable stamp. */
export function localStamp(utc, tz = 'Europe/Rome') {
  const d = new Date(String(utc).trim().replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(utc).trim()) ? '' : 'Z'))
  if (isNaN(d)) throw new Error('unreadable performedAt: ' + utc)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

const isNum = v => typeof v === 'number' && isFinite(v)

/** One exercise's sets with the two inferences applied. Pure; `where` only labels the report. */
export function inferSets(name, rawSets, report, where = '') {
  const bodyweight = BODYWEIGHT.test(name)
  let sets = (rawSets || []).map(s => ({
    w: isNum(s?.weight) && s.weight > 0 ? s.weight : null,
    r: isNum(s?.reps) && s.reps > 0 ? Math.round(s.reps) : null,
    rir: isNum(s?.rir) && s.rir >= 0 ? s.rir : null,
    note: '', warm: false,
  // A set is its reps: a weight with none is a row Lyfta left half-filled, not a set lifted.
  })).filter(s => s.r != null)

  if (bodyweight) return sets

  let last = null
  sets = sets.filter((s, i) => {
    if (s.w == null) {
      if (last == null) { report.dropped.push(`${where}${name} set ${i + 1}: ${s.r} reps, no weight and no set before it`); return false }
      s.w = last
      s.note = CARRIED_NOTE
      report.carried.push(`${where}${name} set ${i + 1}: ${last} kg x ${s.r}`)
    }
    last = s.w
    return true
  })
  const top = Math.max(0, ...sets.map(s => s.w))
  if (sets.length >= 2 && top > 0) {
    for (const s of sets) {
      if (s.w < top * WARMUP_RATIO && s.rir == null) {
        s.warm = true
        report.warmups.push(`${where}${name} ${s.w} x ${s.r}`)
      } else break
    }
  }
  return sets
}

/**
 * Lyfta workouts -> { csv, report }. `report` lists every inference (warm-ups, carried
 * weights, dropped sets, renamed exercises) and the counts, for the summary.
 */
export function lyftaToCSV(workouts, { tz = 'Europe/Rome', names = {} } = {}) {
  const list = Array.isArray(workouts) ? workouts : [workouts]
  const rename = new Map(Object.entries(names || {}).map(([k, v]) => [clean(k).toLowerCase(), clean(v)]))
  const report = { workouts: 0, sets: 0, warmups: [], carried: [], dropped: [], renamed: [], skipped: [] }
  const rows = [LYFTA_HEADER]
  const seen = new Set()

  // Oldest first, and each Lyfta id once: two reads of the connector that overlap must not
  // file the same session twice.
  const sorted = list.filter(Boolean).slice().sort((a, b) => String(a.performedAt).localeCompare(String(b.performedAt)))
  for (const w of sorted) {
    if (w.workoutId != null) { if (seen.has(w.workoutId)) continue; seen.add(w.workoutId) }
    let when
    try { when = localStamp(w.performedAt, tz) } catch { report.skipped.push(`workout ${w.workoutId ?? '?'}: unreadable date ${w.performedAt}`); continue }
    const title = clean(w.title) || 'Lyfta'
    const where = `${when.slice(0, 10)} ${title}: `
    report.workouts++
    for (const ex of w.exercises || []) {
      const original = clean(ex?.name)
      if (!original) continue
      const name = rename.get(original.toLowerCase()) || original
      if (name !== original && !report.renamed.some(r => r.startsWith(original + ' ->'))) report.renamed.push(`${original} -> ${name}`)
      for (const s of inferSets(name, ex.sets, report, where)) {
        rows.push([title, when, name, s.w, s.r, s.rir, s.warm ? 'warmup' : 'normal', s.note])
        report.sets++
      }
    }
  }
  return { csv: rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n', report }
}
