import { describe, it, expect } from 'vitest'
import { lyftaToCSV, inferSets, localStamp, CARRIED_NOTE } from './import-lyfta.js'
import { parseWorkoutCSV } from './import-csv.js'

const report = () => ({ warmups: [], carried: [], dropped: [] })
const set = (weight, reps, rir = null) => ({ weight, reps, rir, duration: null, distance: null, completed: false })

describe('Lyfta timestamps', () => {
  it('are UTC and land on the local clock', () => {
    expect(localStamp('2026-10-12 16:26:05')).toBe('2026-10-12 18:26')       // CEST
    expect(localStamp('2026-11-02 16:26:05')).toBe('2026-11-02 17:26')       // CET
    expect(localStamp('2026-10-12 23:30:00')).toBe('2026-10-13 01:30')       // next local day
    expect(localStamp('2026-10-12 16:26:05', 'UTC')).toBe('2026-10-12 16:26')
  })
  it('refuse a broken stamp rather than inventing a date', () => {
    expect(() => localStamp('yesterday')).toThrow()
  })
})

describe('warm-ups', () => {
  it('are the leading sets under 70 % of the top set', () => {
    const r = report()
    const s = inferSets('Lever Incline Chest Press', [set(40, 5), set(50, 5), set(80, 8), set(80, 5)], r)
    expect(s.map(x => x.warm)).toEqual([true, true, false, false])
    expect(r.warmups).toHaveLength(2)
  })
  it('stop at the first working set, so a back-off set later stays a working set', () => {
    const s = inferSets('Cable Curl', [set(30, 10), set(15, 12)], report())
    expect(s.map(x => x.warm)).toEqual([false, false])
  })
  it('leave a set alone when the athlete rated it', () => {
    const s = inferSets('Shrug', [set(10, 10, 3), set(25, 10)], report())
    expect(s[0].warm).toBe(false)
  })
  it('are never inferred on a bodyweight movement, where the weight is the added load', () => {
    const s = inferSets('Chest Dip', [set(5, 8), set(10, 5), set(10, 6)], report())
    expect(s.every(x => !x.warm)).toBe(true)
    expect(inferSets('Chest Dip', [set(null, 12)], report())[0]).toMatchObject({ w: null, r: 12 })
  })
  it('need at least two sets to compare', () => {
    expect(inferSets('Lateral Raise', [set(12.5, 10)], report())[0].warm).toBe(false)
  })
})

describe('missing weights', () => {
  it('copy the set before and say so', () => {
    const r = report()
    const s = inferSets('Seated Wide-grip Row', [set(52.5, 10), set(null, 5)], r)
    expect(s[1]).toMatchObject({ w: 52.5, r: 5, note: CARRIED_NOTE })
    expect(r.carried).toHaveLength(1)
  })
  it('drop a first set with nothing to copy, rather than guess a load', () => {
    const r = report()
    const s = inferSets('Shrug', [set(null, 15), set(20, 15)], r)
    expect(s).toHaveLength(1)
    expect(r.dropped).toHaveLength(1)
  })
  it('skip empty and nonsense sets', () => {
    // a negative weight is no weight, so with nothing before it that set goes too
    expect(inferSets('Shrug', [set(null, null), set(-5, 10), set(20, 0), set(20, 12)], report()).map(s => [s.w, s.r]))
      .toEqual([[20, 12]])
  })
})

const W = (id, at, title, exercises) => ({ workoutId: id, title, performedAt: at, exercises })

describe('lyftaToCSV', () => {
  const sample = [
    W(2, '2026-10-13 13:46:37', 'Pull A', [
      { name: 'Cable Lateral Pulldown with V-bar', sets: [set(18, 8), set(42, 9), set(null, 6)] },
      { name: 'Reverse Pec Fly Unilaterale', sets: [set(30, 10), set(35, 12)] },
    ]),
    W(1, '2026-10-12 16:26:05', 'Chest + Tricipiti', [
      { name: 'Lever Parallel Chest Press', sets: [set(55, 8), set(75, 10), set(85, 10, 1)] },
      { name: 'Pushdown Ai Cavi Unilaterale', sets: [set(10, 8)] },
      { name: 'Chest Dip', sets: [set(null, 12)] },
    ]),
  ]

  it('round-trips through the CSV importer: sessions, dates, warm-ups, effort and body parts', () => {
    const { csv, report: r } = lyftaToCSV(sample, { names: { 'Pushdown Ai Cavi Unilaterale': 'cable one arm tricep pushdown' } })
    expect(r).toMatchObject({ workouts: 2, sets: 10 })
    const p = parseWorkoutCSV(csv, { unit: 'kg' })
    expect(p.skipped).toBe(0)
    expect(p.workouts.map(w => [w.d, w.name])).toEqual([['2026-10-12', 'Chest + Tricipiti'], ['2026-10-13', 'Pull A']])
    expect(new Date(p.workouts[0].start).getHours()).toBe(18)

    const chest = p.workouts[0].entries.find(e => e.id === '1029')
    expect(chest.sets[0]).toMatchObject({ w: 55, r: 8, phase: 'warmup' })
    expect(chest.sets[2]).toMatchObject({ w: 85, r: 10, rir: 1 })
    expect(chest.topW).toBe(85)
    expect(p.workouts[0].entries.map(e => e.id)).toContain('1723')        // renamed, then matched
    const dip = p.workouts[0].entries.find(e => e.id === '0251')
    expect(dip.sets[0]).toMatchObject({ w: 0, r: 12 })

    const pull = p.workouts[1].entries.find(e => e.id === '2616')         // the V-bar one
    expect(pull.sets.map(s => s.w)).toEqual([18, 42, 42])
    expect(pull.note).toBe(CARRIED_NOTE)
    const fly = p.customEx.find(c => c.n === 'reverse pec fly unilaterale')
    expect(fly.bp).toBe('shoulders')
  })

  it('files each Lyfta session once, however many reads overlap', () => {
    const { report: r } = lyftaToCSV([...sample, ...sample])
    expect(r.workouts).toBe(2)
  })

  it('reports a session with a broken date instead of dropping the file', () => {
    const { report: r } = lyftaToCSV([W(9, 'garbage', 'X', []), ...sample])
    expect(r.workouts).toBe(2)
    expect(r.skipped).toHaveLength(1)
  })

  it('quotes names with commas', () => {
    const { csv } = lyftaToCSV([W(3, '2026-10-14 10:00:00', 'Push, heavy', [{ name: 'Bench Press, Close Grip', sets: [set(60, 5)] }])])
    expect(csv).toContain('"Push, heavy"')
    expect(parseWorkoutCSV(csv).workouts[0].name).toBe('Push, heavy')
  })
})
