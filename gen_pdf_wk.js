#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const cmdOptions = require('commander');
const dom = require('xmldom').DOMParser;
const fs = require('fs-extra');
const fsp = require('fs-promise');
const fileUrl = require('file-url');
const htmltidy = require('htmltidy2');
const less = require('less');
const path = require('path');
const selectn = require('selectn');
const streamToPromise = require('stream-to-promise');
const xpath = require('xpath');

const configLoader = require('./gen_pdf_wk_loadConfig.js');

// Convert string representing integers to a number. Throws if failed.
function filterInt(value) {
  if(/^(\-|\+)?([0-9]+|Infinity)$/.test(value))
    return Number(value);
  throw(new Error(`Unable to parse "${value}" as an integer.`));
}

// Wrapper around 'file-url' module. It converts Windows drive letters to lower
// case so QT can understand them.
function getQTCompatibleFileUrl(path) {
  return fileUrl(path).replace(new RegExp('^file:///[A-Z]:/'),
                               match => match.toLowerCase());
}

// Convenience function to get the source path of the asset.
function getAssetSrcPath(assetName) {
  return path.join(config.root, selectn(assetName, config));
}

class GitbookToWkhtmltopdf {
  constructor(assetMap) {
    this._docList = [];
    this._assetMap = assetMap;
  }

  _getAssetDescPath(assetName) {
    return this._assetMap.get(getAssetSrcPath(assetName));
  }

  _processNodes(select, nodes, level) {
    for (const node of nodes) {
      const url = select('./html:span/html:a/@href', node)[0].value;
      const title =
          select('normalize-space(./html:span/html:a/text())', node).toString();
      this._docList.push({'url' : url, 'title' : title, 'level' : level});
      const subNodes = select('./html:ol/html:li', node);
      this._processNodes(select, subNodes, level + 1);
    }
  }

  _doCommand() {
    let args = [];
    args.push('-T', config.margin.top,
              '-B', config.margin.bottom,
              '-L', config.margin.left,
              '-R', config.margin.right);

    if (config.title) args.push('--title', config.title);

    const argsForAllPages =
        ['--zoom', cmdOptions.zoom, '--debug-javascript',
         '--javascript-delay', cmdOptions.javascriptDelay];

    if (config.cover) {
      args.push('cover', path.relative(cmdOptions.ebookDirectory,
                                       this._getAssetDescPath('cover')),
                '--exclude-from-outline', ...argsForAllPages);
    }

    args.push('toc', ...argsForAllPages);
    if (config.tocXsl) {
      args.push('--xsl-style-sheet',
                path.relative(cmdOptions.ebookDirectory,
                              this._getAssetDescPath('tocXsl')));
    }

    let argsForNormalPages = [...argsForAllPages];
    for (let section of ['header', 'footer']) {
      let sectionConfig = config[section];
      if (!sectionConfig.contentHtml) continue;
      argsForNormalPages.push(
          `--${section}-html`,
          getQTCompatibleFileUrl(
              this._getAssetDescPath(`${section}.contentHtml`)),
          `--${section}-spacing`, sectionConfig.spacing);
    }
    Object.freeze(argsForNormalPages);

    for (const doc of this._docList)
      args.push(path.normalize(doc.url), ...argsForNormalPages);

    args.push(path.relative(cmdOptions.ebookDirectory, cmdOptions.outputFile));

    const cmd_options = {
      cwd: cmdOptions.ebookDirectory,
      stdio: 'inherit',
      timeout: 200000  // wkhtmltopdf can infinitely loop in some cases.
    };

    console.log('Launching wkhtmltopdf:');
    childProcess.spawnSync('wkhtmltopdf', args, cmd_options);
  }

  process(xml) {
    const doc = new dom().parseFromString(xml);
    const select =
        xpath.useNamespaces({'html': 'http://www.w3.org/1999/xhtml'});

    const nodes =
        select('//html:div[contains(@class,"toc")]/html:ol/html:li', doc);
    this._processNodes(select, nodes, 1);
    this._doCommand();
  }
}

// Build with GitBook if needed.
function maybeBuildBook() {
  if (!cmdOptions.build && fs.existsSync(cmdOptions.ebookDirectory) &&
      fs.statSync(cmdOptions.ebookDirectory).isDirectory()) {
    return;
  }
  console.log('Running GitBook:');
  let args = ['build', '.', cmdOptions.ebookDirectory, '--format', 'ebook'];
  childProcess.spawnSync('gitbook', args, { shell: true, stdio: 'inherit' });
}

// Process the assets. Returns the mapping from source to destination.
function processAssets() {
  const assets = new Set(
     [...config.assets, config.cover,
      selectn('header.contentHtml', config),
      selectn('footer.contentHtml', config)]
         .filter(v => v)
         .map(v => path.join(config.root, v)));

  let assetMap = new Map();
  let assetReverseMap = new Map();
  for (const assetSrc of assets) {
    const assetDestBase = path.join(cmdOptions.ebookDirectory,
                                    path.basename(assetSrc));
    let assetDest;
    if (assetReverseMap.has(assetDestBase)) {
      for (let i = 1; ; ++i) {
        assetDest = assetDestBase + '_' + i;
        if (!assetReverseMap.has(assetDest))
          break;
      }
    } else {
      assetDest = assetDestBase;
    }

    assetMap.set(assetSrc, assetDest);
    assetReverseMap.set(assetDest, assetSrc);
  }

  return new Promise((resolve, reject) => {
    Promise.all([...assetMap].map(([src, dest]) => {
      switch (path.extname(src).toLowerCase()) {
      case '.less': {
        console.log('Processing LESS asset: %s => %s', src, dest);
        const cssDest = dest.replace(/\.less$/, '.css');
        return fsp.readFile(src, 'utf8')
                  .then(data => less.render(data, {filename: src}))
                  .then(output => fsp.writeFile(cssDest, output.css, 'utf8'));
      }
      case '.xsl': {
        console.log('Processing XSL asset: %s => %s', src, dest);
        return fsp.readFile(src, 'utf8')
                  .then(data => {
                    // Replace parts of URL for QT XSL.
                    let url = getQTCompatibleFileUrl(cmdOptions.ebookDirectory)
                                  .replace('%20', ' ');
                    let processedData = data.replace('%url_current_dir%', url);
                    return fsp.writeFile(dest, processedData, 'utf8');
                  });
      }
      default: {
        console.log('Copying asset: %s => %s', src, dest);
        return fsp.copy(src, dest, {clobber: true});
      }}
    }))
    .then(() => resolve(assetMap));
  });
}

// Process the summary. Return the processed summary as xhtml.
function processSummary() {
  return streamToPromise(
    fs.createReadStream(path.join(cmdOptions.ebookDirectory, 'SUMMARY.html'))
      .pipe(htmltidy.createWorker({
        'input-encoding': 'utf8',
        'output-encoding': 'utf8',
        'output-xhtml': true})))
  .then(buffer => {
    return fsp.writeFile(path.join(cmdOptions.ebookDirectory, 'SUMMARY.xhtml'),
                         buffer, 'utf8')
              .then(() => buffer.toString());
  });
}

cmdOptions
    .version('0.0.1')
    .option('-D, --ebook-directory <path>',
            'Set the temp directory of the generated ebook. [default: _ebook] Caution: errors will happen if a delimeter (space, comma, semicolon, equal     ) is present in this option.',
            '_ebook')
    .option('-o, --output-file <file>',
            'Set the output file. [default: book_wk.pdf]', 'book_wk.pdf')
    .option('-z, --zoom <float>',
            'Set the zoom level. The default is meant to offset QT smart shrink. [default: 1.2]',
            parseFloat, 1.2)
    .option('-j, --javascript-delay <msec>',
            'Allow the specified number of milliseconds for the javascript to finish. [default: 1000]',
            filterInt, 1000)
    .option('-n, --no-build', 'Do not rebuild tempororary files.')
    .parse(process.argv);

let config;
// Load config file.
configLoader.loadConfig()
.then(rawConfig => {
  config = rawConfig.wkhtmltopdf;

  // Some config in other sections are copied to the wkhtmltopdf config.
  config.root = rawConfig.root;
  if (!config.title) config.title = rawConfig.title;
  config.summary = rawConfig.structure.summary;

  Object.freeze(config);

  maybeBuildBook();

  return Promise.all([processSummary(), processAssets()]);
})
.then(([xml, assetMap]) => {
  new GitbookToWkhtmltopdf(assetMap).process(xml);
})
.catch(err => {console.error(err.stack);});
