import { createServer } from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import open from 'open';
import SpotifyWebApi from 'spotify-web-api-node';
import {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  TOKEN_PATH,
  SCOPES,
} from './config.js';
import { ensureCerts } from './certs.js';

export function loadTokens() {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveTokens(tokens) {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

export function createApi(tokens) {
  const api = new SpotifyWebApi({
    clientId: SPOTIFY_CLIENT_ID,
    clientSecret: SPOTIFY_CLIENT_SECRET,
    redirectUri: SPOTIFY_REDIRECT_URI,
  });

  if (tokens) {
    api.setAccessToken(tokens.accessToken);
    api.setRefreshToken(tokens.refreshToken);
  }

  return api;
}

async function refreshAccessToken(api, tokens) {
  const data = await api.refreshAccessToken();
  const body = data.body;
  const updated = {
    ...tokens,
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  saveTokens(updated);
  api.setAccessToken(updated.accessToken);
  return updated;
}

export async function ensureValidToken(api, tokens) {
  if (!tokens) return null;

  const bufferMs = 60_000;
  if (tokens.expiresAt && Date.now() < tokens.expiresAt - bufferMs) {
    return tokens;
  }

  return refreshAccessToken(api, tokens);
}

export async function authenticate() {
  const api = createApi();
  const authUrl = api.createAuthorizeURL(SCOPES.split(' '));
  const { key, cert } = await ensureCerts();

  return new Promise((resolve, reject) => {
    const server = createServer({ key, cert }, async (req, res) => {
      const url = new URL(req.url, SPOTIFY_REDIRECT_URI);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400);
        res.end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(error));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        server.close();
        reject(new Error('Missing authorization code'));
        return;
      }

      try {
        const api = createApi();
        const data = await api.authorizationCodeGrant(code);
        const body = data.body;

        const tokens = {
          accessToken: body.access_token,
          refreshToken: body.refresh_token,
          expiresAt: Date.now() + body.expires_in * 1000,
        };

        saveTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body style="font-family:sans-serif;text-align:center;padding:4rem">' +
            '<h1>Connected to Spotify</h1><p>You can close this tab and return to the terminal.</p>' +
            '</body></html>'
        );
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500);
        res.end('Token exchange failed');
        server.close();
        reject(err);
      }
    });

    const port = new URL(SPOTIFY_REDIRECT_URI).port || 8888;

    server.listen(port, '127.0.0.1', async () => {
      console.log('Opening browser for Spotify login...');
      console.log(
        'Note: your browser may warn about the local HTTPS certificate — proceed to continue.'
      );
      console.log('If the browser does not open, visit:\n', authUrl);
      try {
        await open(authUrl);
      } catch {
        // headless environments may not have a browser
      }
    });

    server.on('error', reject);
  });
}

export async function getAuthenticatedApi() {
  let tokens = loadTokens();
  const api = createApi(tokens);

  if (!tokens) {
    tokens = await authenticate();
    api.setAccessToken(tokens.accessToken);
    api.setRefreshToken(tokens.refreshToken);
    return api;
  }

  await ensureValidToken(api, tokens);
  return api;
}
