const STATUS_MESSAGES = {
  401: 'Authentication expired — run `npm run auth` to reconnect.',
  403:
    'Access denied. The Spotify Developer account that owns this app must have an active Premium subscription.',
  404: 'Resource not found.',
  429: 'Too many requests — slow down and try again.',
};

export function formatSpotifyError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;

  const body = err.body;
  if (body?.error) {
    if (typeof body.error === 'string') {
      return body.error_description
        ? `${body.error}: ${body.error_description}`
        : body.error;
    }
    if (body.error.message) {
      const reason = body.error.reason ? ` (${body.error.reason})` : '';
      return body.error.message + reason;
    }
  }

  if (err.message && err.message !== '[object Object]') {
    return err.message;
  }

  if (err.statusCode && STATUS_MESSAGES[err.statusCode]) {
    return STATUS_MESSAGES[err.statusCode];
  }

  if (err.statusCode) {
    return `Spotify API error (HTTP ${err.statusCode})`;
  }

  return 'An unexpected error occurred';
}
