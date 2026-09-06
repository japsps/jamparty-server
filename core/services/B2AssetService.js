const axios = require('axios');
const Logger = require('../utils/logger');

const logger = new Logger('B2-ASSETS');
const B2_AUTHORIZE_URL = 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account';

function configuredOrigins() {
  return (process.env.ASSET_PROXY_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function publicAssetBaseUrl() {
  return (process.env.ASSET_PUBLIC_URL || '').trim().replace(/\/$/, '');
}

/** Replaces configured source-CDN URLs in JSON with URLs served by this app. */
function rewriteAssetUrls(value) {
  const origins = configuredOrigins();
  const baseUrl = publicAssetBaseUrl();
  if (!origins.length || !baseUrl) return value;

  if (typeof value === 'string') {
    try {
      const parsed = new URL(value);
      if (origins.includes(parsed.origin)) return `${baseUrl}/assets${parsed.pathname}`;
    } catch (_) {
      // Not an HTTP URL.
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(rewriteAssetUrls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteAssetUrls(item)]));
  }
  return value;
}

class B2AssetService {
  constructor() {
    this.keyId = process.env.B2_KEY_ID;
    this.applicationKey = process.env.B2_APPLICATION_KEY;
    this.bucketName = process.env.B2_BUCKET_NAME;
    this.filePrefix = (process.env.B2_FILE_PREFIX || '').replace(/^\/+|\/+$/g, '');
    this.authorization = null;
  }

  isConfigured() {
    return Boolean(this.keyId && this.applicationKey && this.bucketName);
  }

  async authorize(force = false) {
    if (this.authorization && !force) return this.authorization;
    if (!this.isConfigured()) {
      throw new Error('B2 storage is not configured. Set B2_KEY_ID, B2_APPLICATION_KEY, and B2_BUCKET_NAME.');
    }

    const credentials = Buffer.from(`${this.keyId}:${this.applicationKey}`).toString('base64');
    const response = await axios.get(B2_AUTHORIZE_URL, {
      headers: { Authorization: `Basic ${credentials}` },
      validateStatus: () => true
    });
    if (response.status !== 200) {
      throw new Error(`B2 authorization failed (${response.status}). Check the B2 application key and its permissions.`);
    }

    const storageApi = response.data.apiInfo?.storageApi || response.data;
    if (!response.data.authorizationToken || !storageApi.downloadUrl) {
      throw new Error('B2 authorization response did not include a download URL.');
    }
    this.authorization = {
      token: response.data.authorizationToken,
      downloadUrl: storageApi.downloadUrl.replace(/\/$/, '')
    };
    logger.info('Connected to private B2 storage');
    return this.authorization;
  }

  getSafeFileName(requestPath) {
    const decoded = decodeURIComponent(requestPath);
    const segments = decoded.split('/');
    if (!decoded || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
      throw new Error('Invalid asset path.');
    }
    return [this.filePrefix, decoded].filter(Boolean).join('/');
  }

  makeDownloadUrl(downloadUrl, fileName) {
    const encodedFileName = fileName.split('/').map(encodeURIComponent).join('/');
    return `${downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${encodedFileName}`;
  }

  async download(fileName, headers, retry = true) {
    const auth = await this.authorize();
    const response = await axios.get(this.makeDownloadUrl(auth.downloadUrl, fileName), {
      headers: { Authorization: auth.token, ...(headers.range ? { Range: headers.range } : {}) },
      responseType: 'stream',
      validateStatus: () => true
    });
    if (response.status === 401 && retry) {
      this.authorization = null;
      return this.download(fileName, headers, false);
    }
    return response;
  }
}

module.exports = { B2AssetService, rewriteAssetUrls };
