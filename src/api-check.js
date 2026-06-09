export async function getSpotifyAccessError(accessToken) {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.ok) return null;

  const text = (await res.text()).trim();
  return text || `Spotify API error (HTTP ${res.status})`;
}
