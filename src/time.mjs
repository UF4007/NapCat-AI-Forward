// "2026-10-23 17:05" in the given time zone.
export function formatTime(time, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(time));
}

// "2026-10-23" in the given time zone.
export function formatDate(time, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
}
