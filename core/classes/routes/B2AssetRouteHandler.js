const RouteHandler = require('./RouteHandler');
const { B2AssetService } = require('../../services/B2AssetService');

const FORWARDED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'content-disposition', 'etag', 'last-modified'];

class B2AssetRouteHandler extends RouteHandler {
  constructor() {
    super('B2AssetRouteHandler');
    this.b2 = new B2AssetService();
    this.handleAsset = this.handleAsset.bind(this);
  }

  initroute(app) {
    this.registerGet(app, '/assets/*', this.handleAsset);
    this.logger.info('Registered private B2 asset proxy at /assets/*');
  }

  async handleAsset(req, res) {
    let fileName;
    try {
      fileName = this.b2.getSafeFileName(req.params[0]);
    } catch (_) {
      return res.status(400).send('Invalid asset path');
    }

    let upstream;
    try {
      upstream = await this.b2.download(fileName, req.headers);
    } catch (error) {
      this.logger.error(error.message);
      return res.status(503).send('Asset storage is unavailable');
    }

    FORWARDED_HEADERS.forEach((header) => {
      if (upstream.headers[header]) res.setHeader(header, upstream.headers[header]);
    });
    res.status(upstream.status);
    if (upstream.status >= 400) {
      upstream.data.resume();
      return res.send('Asset not found');
    }

    upstream.data.on('error', (error) => {
      this.logger.error(`Asset stream failed: ${error.message}`);
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error);
    });
    upstream.data.pipe(res);
  }
}

module.exports = new B2AssetRouteHandler();
