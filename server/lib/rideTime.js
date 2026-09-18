const TIME_VALUE_REGEX = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function pad(value) {
  return String(value).padStart(2, '0');
}

function parseTimeValue(time) {
  if (!time) return null;
  const match = String(time).trim().match(TIME_VALUE_REGEX);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? '0');

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  return { hour, minute, second };
}

export function normalizeHourlyTime(time) {
  const parsed = parseTimeValue(time);
  if (!parsed || parsed.minute !== 0 || parsed.second !== 0) return null;
  return `${pad(parsed.hour)}:00:00`;
}

export function addHourToTime(time) {
  const parsed = parseTimeValue(time);
  if (!parsed) return null;

  const totalMinutes = parsed.hour * 60 + parsed.minute + 60;
  const wrapped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const nextHour = Math.floor(wrapped / 60);
  const nextMinute = wrapped % 60;
  return `${pad(nextHour)}:${pad(nextMinute)}:00`;
}

export function normalizeRideSlot({ startTime, endTime, rideTime }) {
  const normalizedStart = normalizeHourlyTime(startTime || rideTime);
  if (!normalizedStart) {
    return {
      ok: false,
      error: 'Please select a full 1-hour time slot.',
    };
  }

  const normalizedEnd = endTime ? normalizeHourlyTime(endTime) : addHourToTime(normalizedStart);
  if (!normalizedEnd) {
    return {
      ok: false,
      error: 'Please select a full 1-hour time slot.',
    };
  }

  const expectedEnd = addHourToTime(normalizedStart);
  if (normalizedEnd !== expectedEnd) {
    return {
      ok: false,
      error: 'Ride time must be exactly 1 hour long.',
    };
  }

  return {
    ok: true,
    startTime: normalizedStart,
    endTime: normalizedEnd,
    rideTime: normalizedStart,
  };
}

