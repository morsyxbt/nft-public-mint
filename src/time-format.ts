// Mint times get announced in IST unless an explicit timezone is given, so
// every command prints them that way.

const IST_OFFSET_MIN = 330; // +5:30
const IST_OFFSET_MS = IST_OFFSET_MIN * 60 * 1000;

export function toIST(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDate();
  const month = ist.getUTCMonth() + 1;
  const year = ist.getUTCFullYear();
  const hours = ist.getUTCHours();
  const minutes = ist.getUTCMinutes().toString().padStart(2, "0");
  const seconds = ist.getUTCSeconds().toString().padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;
  return `${day}/${month}/${year}, ${h12}:${minutes}:${seconds} ${ampm}`;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH_RE = new RegExp(
  `\\b(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|")})\\b\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`
);

// Parse an optional timezone suffix. Defaults to IST when none is present, and
// returns the remaining text with the tz tokens stripped.
function parseTz(s: string): { tzMin: number; rest: string } {
  let tzMin = IST_OFFSET_MIN;
  const strip = (m: RegExpExecArray): string =>
    (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();

  const gmt = /gmt\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/.exec(s);
  if (gmt) {
    const sign = gmt[1] === "-" ? -1 : 1;
    tzMin = sign * (Number(gmt[2]) * 60 + (gmt[3] ? Number(gmt[3]) : 0));
    return { tzMin, rest: strip(gmt) };
  }

  const utc = /utc(?:\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?)?/.exec(s);
  if (utc) {
    if (utc[1]) {
      const sign = utc[1] === "-" ? -1 : 1;
      tzMin = sign * (Number(utc[2]) * 60 + (utc[3] ? Number(utc[3]) : 0));
    } else {
      tzMin = 0;
    }
    return { tzMin, rest: strip(utc) };
  }

  const off = /(^|\s)([+-]\d{1,2}(?::\d{2})?)(?=\s|$)/.exec(s);
  if (off) {
    const v = off[2];
    const sign = v[0] === "-" ? -1 : 1;
    const [h, mm] = v.slice(1).split(":");
    tzMin = sign * (Number(h) * 60 + (mm ? Number(mm) : 0));
    return { tzMin, rest: strip(off) };
  }

  return { tzMin, rest: s };
}

// Current wall-clock date in a given timezone offset (minutes from UTC).
function tzRef(tzMin: number): { y: number; m: number; d: number } {
  const n = new Date(Date.now() + tzMin * 60000);
  return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() };
}

// Parses human fire-time strings into an absolute UTC Date.
//
// Accepts OpenSea-style "August 29 at 2:00 AM GMT+7", plus the older forms:
// "HH:MM" (today, IST), "DD/MM HH:MM", "DD/MM/YYYY HH:MM", and
// "tomorrow HH:MM". With no timezone the time is read as IST.
export function parseFireTime(raw: string): Date {
  const s = raw.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!s) throw new Error("Empty input — e.g. 'August 29 at 2:00 AM GMT+7' or 'HH:MM'");

  const { tzMin, rest } = parseTz(s);

  const timeMatch = /(\d{1,2}):(\d{2})(?:\s*(am|pm))?/.exec(rest);
  if (!timeMatch) throw new Error("No time found — use HH:MM (24-hour) or '2:00 AM'");
  let hh = Number(timeMatch[1]);
  const mm = Number(timeMatch[2]);
  if (timeMatch[3] === "pm" && hh < 12) hh += 12;
  if (timeMatch[3] === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) throw new Error("Invalid time — use HH:MM (24-hour) or '2:00 AM'");

  const ref = tzRef(tzMin);
  let y = ref.y;
  let mo = ref.m;
  let d = ref.d;

  const mon = MONTH_RE.exec(rest);
  if (mon) {
    mo = MONTHS[mon[1]];
    d = Number(mon[2]);
    y = mon[3] ? Number(mon[3]) : ref.y;
  } else {
    const num = /(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?/.exec(rest);
    if (num) {
      d = Number(num[1]);
      mo = Number(num[2]);
      y = num[3] ? Number(num[3]) : ref.y;
    } else if (/\btomorrow\b/.test(rest)) {
      const tm = new Date(Date.now() + tzMin * 60000);
      tm.setUTCHours(0, 0, 0, 0);
      tm.setUTCDate(tm.getUTCDate() + 1);
      y = tm.getUTCFullYear();
      mo = tm.getUTCMonth() + 1;
      d = tm.getUTCDate();
    }
  }

  // Build the wall-clock instant as if it were UTC, then shift back to true UTC.
  const instant = new Date(Date.UTC(y, mo - 1, d, hh, mm, 0, 0));
  if (instant.getUTCFullYear() !== y || instant.getUTCMonth() !== mo - 1 || instant.getUTCDate() !== d)
    throw new Error("Invalid date — use 'Month DD', DD/MM, or DD/MM/YYYY");
  return new Date(instant.getTime() - tzMin * 60000);
}
