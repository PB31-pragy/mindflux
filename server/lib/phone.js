const DEFAULT_COUNTRY_CODE = '91';

export function normalizeMobileNumber(value) {
  if (value === null || value === undefined) return '';

  const raw = String(value).trim();
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 10) {
    return `+${DEFAULT_COUNTRY_CODE}${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    return `+${DEFAULT_COUNTRY_CODE}${digits.slice(-10)}`;
  }

  if (digits.length === 12 && digits.startsWith(DEFAULT_COUNTRY_CODE)) {
    return `+${digits}`;
  }

  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }

  if (digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }

  return '';
}

export function phoneNumberSql(columnName = 'phone_number') {
  const digits = `regexp_replace(COALESCE(${columnName}, ''), '[^0-9]', '', 'g')`;

  return `CASE
    WHEN ${digits} = '' THEN NULL
    WHEN length(${digits}) = 10 THEN '+${DEFAULT_COUNTRY_CODE}' || ${digits}
    WHEN length(${digits}) = 11 AND left(${digits}, 1) = '0' THEN '+${DEFAULT_COUNTRY_CODE}' || right(${digits}, 10)
    WHEN length(${digits}) = 12 AND left(${digits}, 2) = '${DEFAULT_COUNTRY_CODE}' THEN '+' || ${digits}
    WHEN left(COALESCE(${columnName}, ''), 1) = '+' AND length(${digits}) BETWEEN 10 AND 15 THEN '+' || ${digits}
    WHEN length(${digits}) BETWEEN 10 AND 15 THEN '+' || ${digits}
    ELSE NULL
  END`;
}
