/** Ambient flavor lines for the scheduled galaxy pulse — short, in-world rumors. */
export const PULSE_LINES: readonly string[] = [
  'Throne forecast holds at 99.7 percent. Origin: the Shroud.',
  'A pilgrim fleet entered the Shroud. No signal back in forty days.',
  'Interlink chatter: a beacon lit at the edge of the sector.',
  'Mother Stone resonance logged three belts over. Nobody confirms it.',
  'Meridian convoy premiums up again along the contested lanes.',
  'A hull matching a lost registry was sighted, running silent.',
  'Someone is broadcasting on a frequency nobody assigned them.',
  'Static on the long channel again. Comms call it interference.',
  'A relic hums when no one is listening. Reports unconfirmed.',
  'The signal repeats the same six words. No one has traced the source.',
]

export function randomPulseLine(): string {
  const line = PULSE_LINES[Math.floor(Math.random() * PULSE_LINES.length)]
  return line ?? 'Static on the long channel again.'
}
