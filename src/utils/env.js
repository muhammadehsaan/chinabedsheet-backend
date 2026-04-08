const NEON_HOST_PATTERN = /^(ep-[^.]+?)(-pooler)?(\.[^.]+\.aws\.neon\.tech)$/i;

const unwrapQuotedValue = (value) => {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
};

const wrapWithOriginalQuotes = (originalValue, normalizedValue) => {
  const text = String(originalValue || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    return `"${normalizedValue}"`;
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return `'${normalizedValue}'`;
  }
  return normalizedValue;
};

const normalizeDatabaseUrl = (value) => {
  const unwrapped = unwrapQuotedValue(value);
  if (!unwrapped) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(unwrapped);
  } catch (_error) {
    return null;
  }

  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) {
    return null;
  }

  const neonMatch = parsed.hostname.match(NEON_HOST_PATTERN);
  if (!neonMatch) {
    return null;
  }

  const [, projectHost, poolerSuffix, regionHost] = neonMatch;
  if (!poolerSuffix) {
    parsed.hostname = `${projectHost}-pooler${regionHost}`;
  }
  if (!parsed.searchParams.get("sslmode")) {
    parsed.searchParams.set("sslmode", "require");
  }
  if (!parsed.searchParams.get("channel_binding")) {
    parsed.searchParams.set("channel_binding", "require");
  }

  return parsed.toString();
};

const normalizeDatabaseEnv = (envObject = process.env) => {
  const currentValue = envObject.DATABASE_URL;
  const normalized = normalizeDatabaseUrl(currentValue);
  if (!normalized) {
    return { changed: false, value: currentValue || "" };
  }
  const wrapped = wrapWithOriginalQuotes(currentValue, normalized);
  envObject.DATABASE_URL = wrapped;
  return { changed: wrapped !== currentValue, value: wrapped };
};

module.exports = {
  normalizeDatabaseEnv,
  normalizeDatabaseUrl,
};
