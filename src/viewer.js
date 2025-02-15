const path = require('path');
const fs = require('fs');
const http = require('http');

const WebSocket = require('ws');
const _ = require('lodash');
const {bold} = require('chalk');

const Logger = require('./Logger');
const analyzer = require('./analyzer');
const {open} = require('./utils');
const {renderViewer} = require('./template');

import viewerScript from '../public/viewer.js';

function resolveTitle(reportTitle) {
  if (typeof reportTitle === 'function') {
    return reportTitle();
  } else {
    return reportTitle;
  }
}

module.exports = {
  startServer,
  generateReport,
  generateJSONReport,
  // deprecated
  start: startServer
};

async function startServer(bundleStats, opts) {
  const {
    port = 8888,
    host = '127.0.0.1',
    openBrowser = true,
    bundleDir = null,
    logger = new Logger(),
    defaultSizes = 'parsed',
    excludeAssets = null,
    reportTitle
  } = opts || {};

  const analyzerOpts = {logger, excludeAssets};

  let chartData = getChartData(analyzerOpts, bundleStats, bundleDir);

  if (!chartData) return;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      const html = renderViewer({
        mode: 'server',
        title: resolveTitle(reportTitle),
        chartData,
        defaultSizes,
        enableWebSocket: true
      });
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(html);
    } else if (req.method === 'GET' && req.url === '/viewer.js') {
      res.writeHead(200, {'Content-Type': 'text/javascript'});
      res.end(viewerScript);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => {
    server.listen(port, host, () => {
      resolve();

      const url = `http://${host}:${server.address().port}`;

      logger.info(
        `${bold('Speedy Bundle Analyzer')} is started at ${bold(url)}\n` +
        `Use ${bold('Ctrl+C')} to close it`
      );

      if (openBrowser) {
        open(url, logger);
      }
    });
  });

  const wss = new WebSocket.Server({server});

  wss.on('connection', ws => {
    ws.on('error', err => {
      // Ignore network errors like `ECONNRESET`, `EPIPE`, etc.
      if (err.errno) return;

      logger.info(err.message);
    });
  });

  return {
    ws: wss,
    http: server,
    updateChartData
  };

  function updateChartData(bundleStats) {
    const newChartData = getChartData(analyzerOpts, bundleStats, bundleDir);

    if (!newChartData) return;

    chartData = newChartData;

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          event: 'chartDataUpdated',
          data: newChartData
        }));
      }
    });
  }
}

async function generateReport(bundleStats, opts) {
  const {
    openBrowser = true,
    reportFilename,
    reportTitle,
    bundleDir = null,
    logger = new Logger(),
    defaultSizes = 'parsed',
    excludeAssets = null
  } = opts || {};

  const chartData = getChartData({logger, excludeAssets}, bundleStats, bundleDir);

  if (!chartData) return;

  const reportHtml = renderViewer({
    mode: 'static',
    title: resolveTitle(reportTitle),
    chartData,
    defaultSizes,
    enableWebSocket: false
  });
  const reportFilepath = path.resolve(bundleDir || process.cwd(), reportFilename);

  fs.mkdirSync(path.dirname(reportFilepath), {recursive: true});
  fs.writeFileSync(reportFilepath, reportHtml);

  logger.info(`${bold('Speedy Bundle Analyzer')} saved report to ${bold(reportFilepath)}`);

  if (openBrowser) {
    open(`file://${reportFilepath}`, logger);
  }
}

async function generateJSONReport(bundleStats, opts) {
  const {reportFilename, bundleDir = null, logger = new Logger(), excludeAssets = null} = opts || {};

  const chartData = getChartData({logger, excludeAssets}, bundleStats, bundleDir);

  if (!chartData) return;

  await fs.promises.mkdir(path.dirname(reportFilename), {recursive: true});
  await fs.promises.writeFile(reportFilename, JSON.stringify(chartData));

  logger.info(`${bold('Speedy Bundle Analyzer')} saved JSON report to ${bold(reportFilename)}`);
}

function getChartData(analyzerOpts, ...args) {
  let chartData;
  const {logger} = analyzerOpts;

  try {
    chartData = analyzer.getViewerData(...args, analyzerOpts);
  } catch (err) {
    logger.error(`Could't analyze Speedy bundle:\n${err}`);
    logger.debug(err.stack);
    chartData = null;
  }

  if (_.isPlainObject(chartData) && _.isEmpty(chartData)) {
    logger.error("Could't find any javascript bundles in provided stats file");
    chartData = null;
  }

  return chartData;
}
