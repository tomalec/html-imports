/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
(function(scope) {

  /********************* base setup *********************/
  const IMPORT_SELECTOR = 'link[rel=import]';
  const useNative = Boolean('import' in document.createElement('link'));
  const flags = {
    bust: false,
    log: false
  };

  // Polyfill `currentScript` for browsers without it.
  let currentScript = null;
  if ('currentScript' in document === false) {
    Object.defineProperty(document, 'currentScript', {
      get: function() {
        return currentScript ||
          // NOTE: only works when called in synchronously executing code.
          // readyState should check if `loading` but IE10 is
          // interactive when scripts run so we cheat.
          (document.readyState !== 'complete' ?
            document.scripts[document.scripts.length - 1] : null);
      },
      configurable: true
    });
  }

  /********************* path fixup *********************/
  const ABS_URL_TEST = /(^\/)|(^#)|(^[\w-\d]*:)/;
  const CSS_URL_REGEXP = /(url\()([^)]*)(\))/g;
  const CSS_IMPORT_REGEXP = /(@import[\s]+(?!url\())([^;]*)(;)/g;

  // path fixup: style elements in imports must be made relative to the main
  // document. We fixup url's in url() and @import.
  const Path = {
    resolveUrlsInStyle: function(style, linkUrl) {
      style.textContent = Path.resolveUrlsInCssText(style.textContent, linkUrl);
    },

    resolveUrlsInCssText: function(cssText, linkUrl) {
      let r = Path.replaceUrls(cssText, linkUrl, CSS_URL_REGEXP);
      r = Path.replaceUrls(r, linkUrl, CSS_IMPORT_REGEXP);
      return r;
    },

    replaceUrls: function(text, linkUrl, regexp) {
      return text.replace(regexp, function(m, pre, url, post) {
        let urlPath = url.replace(/["']/g, '');
        if (linkUrl) {
          urlPath = (new URL(urlPath, linkUrl)).href;
        }
        return pre + '\'' + urlPath + '\'' + post;
      });
    },

    replaceAttrUrl: function(text, linkUrl) {
      if (text && ABS_URL_TEST.test(text)) {
        return text;
      } else {
        return new URL(text, linkUrl).href;
      }
    }
  };

  /********************* Xhr processor *********************/
  const Xhr = {

    async: true,

    /**
     * @param {!string} url
     * @param {!function(boolean, ?, string=)} callback
     * @return {XMLHttpRequest}
     */
    load: function(url, callback) {
      const request = new XMLHttpRequest();
      if (flags.bust) {
        url += '?' + Math.random();
      }
      request.open('GET', url, Xhr.async);
      request.addEventListener('readystatechange', (e) => {
        if (request.readyState === 4) {
          // Servers redirecting an import can add a Location header to help us
          // polyfill correctly.
          let redirectedUrl = undefined;
          try {
            const locationHeader = request.getResponseHeader('Location');
            if (locationHeader) {
              // Relative or full path.
              redirectedUrl = (locationHeader.substr(0, 1) === '/') ?
                location.origin + locationHeader : locationHeader;
            }
          } catch (e) {
            console.error(e.message);
          }
          const isOk = ((request.status >= 200 && request.status < 300) ||
            request.status === 304 || request.status === 0);
          const resource = (request.response || request.responseText);
          callback(!isOk, resource, redirectedUrl);
        }
      });
      request.send();
      return request;
    }
  };

  /********************* loader *********************/
  // This loader supports a dynamic list of urls
  // and an oncomplete callback that is called when the loader is done.
  // NOTE: The polyfill currently does *not* need this dynamism or the
  // onComplete concept. Because of this, the loader could be simplified
  // quite a bit.
  class Loader {
    constructor(onLoad, onComplete) {
      this.cache = {};
      this.onload = onLoad;
      this.oncomplete = onComplete;
      this.inflight = 0;
      this.pending = {};
    }

    addNodes(nodes) {
      // number of transactions to complete
      this.inflight += nodes.length;
      // commence transactions
      for (let i = 0, l = nodes.length, n;
        (i < l) && (n = nodes[i]); i++) {
        this.require(n);
      }
      // anything to do?
      this.checkDone();
    }

    addNode(node) {
      // number of transactions to complete
      this.inflight++;
      // commence transactions
      this.require(node);
      // anything to do?
      this.checkDone();
    }

    require(elt) {
      const url = elt.src || elt.href;
      // deduplication
      if (!this.dedupe(url, elt)) {
        // fetch this resource
        this.fetch(url, elt);
      }
    }

    dedupe(url, elt) {
      if (this.pending[url]) {
        // add to list of nodes waiting for inUrl
        this.pending[url].push(elt);
        // don't need fetch
        return true;
      }
      let resource;
      if (this.cache[url]) {
        this.onload(url, elt, this.cache[url]);
        // finished this transaction
        this.tail();
        // don't need fetch
        return true;
      }
      // first node waiting for inUrl
      this.pending[url] = [elt];
      // need fetch (not a dupe)
      return false;
    }

    fetch(url, elt) {
      flags.log && console.log('fetch', url, elt);
      if (!url) {
        this.receive(url, elt, true, 'error: href must be specified');
      } else if (url.match(/^data:/)) {
        // Handle Data URI Scheme
        const pieces = url.split(',');
        const header = pieces[0];
        let body = pieces[1];
        if (header.indexOf(';base64') > -1) {
          body = atob(body);
        } else {
          body = decodeURIComponent(body);
        }
        this.receive(url, elt, false, body);
      } else {
        Xhr.load(url, (error, resource, redirectedUrl) =>
          this.receive(url, elt, error, resource, redirectedUrl));
      }
    }

    /**
     * @param {!string} url
     * @param {!Element} elt
     * @param {boolean} err
     * @param {string=} resource
     * @param {string=} redirectedUrl
     */
    receive(url, elt, err, resource, redirectedUrl) {
      this.cache[url] = resource;
      const $p = this.pending[url];
      for (let i = 0, l = $p.length, p;
        (i < l) && (p = $p[i]); i++) {
        // If url was redirected, use the redirected location so paths are
        // calculated relative to that.
        this.onload(url, p, resource, err, redirectedUrl);
        this.tail();
      }
      this.pending[url] = null;
    }

    tail() {
      --this.inflight;
      this.checkDone();
    }

    checkDone() {
      if (!this.inflight) {
        this.oncomplete();
      }
    }
  }

  /********************* importer *********************/

  const stylesSelector = [
    'style:not([type])',
    'link[rel=stylesheet][href]:not([type])'
  ].join(',');

  const stylesInImportsSelector = [
    `${IMPORT_SELECTOR} style:not([type])`,
    `${IMPORT_SELECTOR} link[rel=stylesheet][href]:not([type])`
  ].join(',');

  const importsSelectors = [
    IMPORT_SELECTOR,
    stylesSelector,
    'script:not([type])',
    'script[type="application/javascript"]',
    'script[type="text/javascript"]'
  ].join(',');

  // importer
  // highlander object to manage loading of imports
  // for any document, importer:
  // - loads any linked import documents (with deduping)
  // - whenever an import is loaded, prompts the parser to try to parse
  // - observes imported documents for new elements (these are handled via the
  // dynamic importer)
  class Importer {
    /**
     * @param {HTMLDocument} doc
     */
    constructor(doc) {
      this.documents = {};
      // Make sure to catch any imports that are in the process of loading
      // when this script is run.
      const imports = doc.querySelectorAll(IMPORT_SELECTOR);
      for (let i = 0, l = imports.length; i < l; i++) {
        whenElementLoaded(imports[i]);
      }
      // Observe only document head
      new MutationObserver(this._onMutation.bind(this)).observe(doc.head, {
        childList: true
      });

      if (!useNative) {
        this._loader = new Loader(
          this._onLoaded.bind(this), this._onLoadedAll.bind(this)
        );
        whenDocumentReady(doc).then(() => this._loadSubtree(doc));
      }
    }

    _loadSubtree(doc) {
      const nodes = doc.querySelectorAll(IMPORT_SELECTOR);
      // add these nodes to loader's queue
      this._loader.addNodes(nodes);
    }

    _onLoaded(url, elt, resource, err, redirectedUrl) {
      flags.log && console.log('loaded', url, elt);
      // We've already seen a document at this url, return.
      if (this.documents[url] !== undefined) {
        return;
      }
      if (err) {
        this.documents[url] = null;
      } else {
        // Generate an HTMLDocument from data.
        const doc = makeDocument(resource, redirectedUrl || url);
        // note, we cannot use MO to detect parsed nodes because
        // SD polyfill does not report these as mutations.
        this._loadSubtree(doc);
        this.documents[url] = doc;
      }
    }

    _onLoadedAll() {
      this._flatten(document);
      Promise.all([
        runScripts(),
        waitForStyles()
      ]).then(fireEvents);
    }

    _flatten(element) {
      const n$ = element.querySelectorAll(IMPORT_SELECTOR);
      for (let i = 0, l = n$.length, n; i < l && (n = n$[i]); i++) {
        n.import = this.documents[n.href];
        if (n.import && !n.import.__firstImport) {
          n.import.__firstImport = n;
          this._flatten(n.import);
          n.appendChild(n.import);
          // If in the main document, observe for any imports added later.
          if (element === document) {
            this._observe(n.import);
          }
        }
      }
    }

    _observe(element) {
      if (element.__importObserver) {
        return;
      }
      element.__importObserver = new MutationObserver(this._onMutation.bind(this));
      element.__importObserver.observe(element, {
        childList: true,
        subtree: true
      });
    }

    /**
     * @param {Array<MutationRecord>} mutations
     */
    _onMutation(mutations) {
      for (let j = 0, m; j < mutations.length && (m = mutations[j]); j++) {
        for (let i = 0, l = m.addedNodes ? m.addedNodes.length : 0; i < l; i++) {
          const n = /** @type {Element} */ (m.addedNodes[i]);
          if (n && isImportLink(n)) {
            if (useNative) {
              whenElementLoaded(n);
            } else {
              this._loader.addNode(n);
            }
          }
        }
      }
    }

  }

  /**
   * @type {Function}
   */
  const MATCHES = Element.prototype.matches ||
    Element.prototype.matchesSelector ||
    Element.prototype.mozMatchesSelector ||
    Element.prototype.msMatchesSelector ||
    Element.prototype.oMatchesSelector ||
    Element.prototype.webkitMatchesSelector;

  /**
   * @param {!Node} node
   * @return {boolean}
   */
  function isImportLink(node) {
    return node.nodeType === Node.ELEMENT_NODE && MATCHES.call(node, IMPORT_SELECTOR);
  }

  /********************* vulcanize style inline processing  *********************/
  const attrs = ['action', 'src', 'href', 'url', 'style'];

  function fixUrlAttributes(element, base) {
    attrs.forEach((a) => {
      const at = element.attributes[a];
      const v = at && at.value;
      if (v && (v.search(/({{|\[\[)/) < 0)) {
        at.value = (a === 'style') ?
          Path.resolveUrlsInCssText(v, base) :
          Path.replaceAttrUrl(v, base);
      }
    });
  }

  function fixUrlsInTemplate(template, base) {
    const content = template.content;
    if (!content) { // Template not supported.
      return;
    }
    const n$ = content.querySelectorAll('style, form[action], [src], [href], [url], [style]');
    for (let i = 0; i < n$.length; i++) {
      const n = n$[i];
      if (n.localName == 'style') {
        Path.resolveUrlsInStyle(n, base);
      } else {
        fixUrlAttributes(n, base);
      }
    }
    fixUrlsInTemplates(content, base);
  }

  function fixUrlsInTemplates(element, base) {
    const t$ = element.querySelectorAll('template');
    for (let i = 0; i < t$.length; i++) {
      fixUrlsInTemplate(t$[i], base);
    }
  }

  const scriptType = 'import-script';

  function fixUrls(element, base) {
    const n$ = element.querySelectorAll(importsSelectors);
    for (let i = 0, l = n$.length, n; i < l && (n = n$[i]); i++) {
      // Ensure we add load/error listeners before modifying urls or appending
      // these to the main document.
      whenElementLoaded(n);
      if (n.href) {
        n.setAttribute('href', Path.replaceAttrUrl(n.getAttribute('href'), base));
      }
      if (n.src) {
        n.setAttribute('src', Path.replaceAttrUrl(n.getAttribute('src'), base));
      }
      if (n.localName == 'style') {
        Path.resolveUrlsInStyle(n, base);
      } else if (n.localName === 'script') {
        if (n.textContent) {
          n.textContent += `\n//# sourceURL=${base}`;
        }
        // NOTE: we override the type here, might need to keep track of original
        // type and apply it to clone when running the script.
        n.setAttribute('type', scriptType);
      }
    }
    fixUrlsInTemplates(element, base);
  }

  /**
   * Replaces all the imported scripts with a clone in order to execute them.
   * Updates the `currentScript`.
   * @return {Promise} Resolved when scripts are loaded.
   */
  function runScripts() {
    const s$ = document.querySelectorAll(`script[type=${scriptType}]`);
    let promise = Promise.resolve();
    for (let i = 0, l = s$.length, s; i < l && (s = s$[i]); i++) {
      promise = promise.then(() => {
        const c = document.createElement('script');
        c.textContent = s.textContent;
        if (s.src) {
          c.setAttribute('src', s.getAttribute('src'));
        }
        // Listen for load/error events before adding the clone to the document.
        // Catch failures, always return c.
        const whenLoadedPromise = whenElementLoaded(c).catch(() => c);
        // Update currentScript and replace original with clone script.
        currentScript = c;
        s.parentNode.replaceChild(c, s);
        // After is loaded, reset currentScript.
        return whenLoadedPromise.then((script) => {
          if (script === currentScript) {
            currentScript = null;
          }
        });
      });
    }
    return promise;
  }

  function waitForStyles() {
    const s$ = document.querySelectorAll(stylesInImportsSelector);
    const promises = [];
    for (let i = 0, l = s$.length, s; i < l && (s = s$[i]); i++) {
      // Catch failures, always return s
      promises.push(
        whenElementLoaded(s).catch(() => s)
      );
    }
    return Promise.all(promises).then(() => {
      // IE and Edge require styles/links to be siblings in order to apply correctly.
      if ((isIE || isEdge) && s$.length) {
        const n$ = document.head.querySelectorAll(stylesSelector);
        for (let i = 0, l = n$.length, n; i < l && (n = n$[i]); i++) {
          n.parentNode.removeChild(n);
          document.head.appendChild(n);
        }
      }
      return s$;
    });
  }

  function fireEvents() {
    const n$ = /** @type {!NodeList<!HTMLLinkElement>} */
      (document.querySelectorAll(IMPORT_SELECTOR));
    // Inverse order to have events firing bottom-up.
    for (let i = n$.length - 1, n; i >= 0 && (n = n$[i]); i--) {
      // Don't fire twice same event.
      if (!n.__fired) {
        n.__fired = true;
        const eventType = n.import ? 'load' : 'error';
        flags.log && console.warn('fire', eventType, n.href);
        // Ensure the load promise is setup before firing the event.
        whenElementLoaded(n);
        n.dispatchEvent(new CustomEvent(eventType, {
          bubbles: false,
          cancelable: false,
          detail: undefined
        }));
      }
    }
  }

  /**
   * Waits for an element to finish loading. If already done loading, it will
   * mark the elemnt accordingly.
   * @param {!Element} element
   * @return {Promise}
   */
  function whenElementLoaded(element) {
    if (!element.__loadPromise) {
      element.__loadPromise = new Promise((resolve, reject) => {
        if (isElementLoaded(element)) {
          resolve(element);
        } else {
          element.addEventListener('load', () => resolve(element));
          element.addEventListener('error', () => reject(element));
        }
      });
    }
    return element.__loadPromise;
  }

  /**
   * @param {!Element} element
   * @return {boolean}
   */
  function isElementLoaded(element) {
    let isLoaded = false;
    if (useNative && isImportLink(element) && element.import &&
      element.import.readyState !== 'loading') {
      isLoaded = true;
    } else if (isIE && element.localName === 'style') {
      // NOTE: IE does not fire "load" event for styles that have already
      // loaded. This is in violation of the spec, so we try our hardest to
      // work around it.
      // If there's not @import in the textContent, assume it has loaded
      if (element.textContent.indexOf('@import') == -1) {
        isLoaded = true;
        // if we have a sheet, we have been parsed
      } else if (element.sheet) {
        isLoaded = true;
        const csr = element.sheet.cssRules;
        // search the rules for @import's
        for (let i = 0, l = csr ? csr.length : 0; i < l && isLoaded; i++) {
          if (csr[i].type === CSSRule.IMPORT_RULE) {
            // if every @import has resolved, fake the load
            isLoaded = Boolean(csr[i].styleSheet);
          }
        }
      }
    } else if (element.localName === 'script' && !element.src) {
      isLoaded = true;
    }
    return isLoaded;
  }

  function fixDomModules(element, url) {
    const s$ = element.querySelectorAll('dom-module');
    for (let i = 0; i < s$.length; i++) {
      const o = s$[i];
      const assetpath = o.getAttribute('assetpath') || '';
      o.setAttribute('assetpath', Path.replaceAttrUrl(assetpath, url));
    }
  }

  function makeDocument(resource, url) {
    // TODO(valdrin): better to use a disconnected document here so that
    // elements don't upgrade until inserted into main document,
    // however, this is blocked on https://bugs.webkit.org/show_bug.cgi?id=165617
    // let doc = document.implementation.createHTMLDocument();
    const content = document.createElement('import-content');
    content.setAttribute('import-href', url);
    content.style.display = 'none';
    content.innerHTML = resource;

    // TODO(sorvell): this is specific to users (Polymer) of the dom-module element.
    fixDomModules(content, url);
    fixUrls(content, url);
    return content;
  }

  /**
    Add support for the `HTMLImportsLoaded` event and the `HTMLImports.whenReady`
    method. This api is necessary because unlike the native implementation,
    script elements do not force imports to resolve. Instead, users should wrap
    code in either an `HTMLImportsLoaded` handler or after load time in an
    `HTMLImports.whenReady(callback)` call.

    NOTE: This module also supports these apis under the native implementation.
    Therefore, if this file is loaded, the same code can be used under both
    the polyfill and native implementation.
   */

  const isIE = /Trident/.test(navigator.userAgent);
  const isEdge = !isIE && /Edge\/\d./i.test(navigator.userAgent);
  const requiredReadyState = isIE ? 'complete' : 'interactive';
  const READY_EVENT = 'readystatechange';

  // call a callback when all HTMLImports in the document at call time
  // (or at least document ready) have loaded.
  // 1. ensure the document is in a ready state (has dom), then
  // 2. watch for loading of imports and call callback when done
  function whenReady(callback, doc) {
    doc = doc || document;
    // if document is loading, wait and try again
    return whenDocumentReady(doc).then(watchImportsLoad).then((importInfo) => {
      callback && callback(importInfo);
      return importInfo;
    });
  }

  function isDocumentReady(doc) {
    return (doc.readyState === 'complete' ||
      doc.readyState === requiredReadyState);
  }

  // call <callback> when we ensure the document is in a ready state
  function whenDocumentReady(doc) {
    if (isDocumentReady(doc)) {
      return Promise.resolve(doc);
    }
    return new Promise((resolve) => {
      doc.addEventListener(READY_EVENT, function checkReady() {
        if (isDocumentReady(doc)) {
          doc.removeEventListener(READY_EVENT, checkReady);
          resolve(doc);
        }
      });
    });
  }

  // call <callback> when we ensure all imports have loaded
  function watchImportsLoad(doc) {
    let imports = doc.querySelectorAll(IMPORT_SELECTOR);
    const promises = [];
    const importInfo = /** @type {!HTMLImportInfo} */ ({
      allImports: [],
      loadedImports: [],
      errorImports: []
    });
    for (let i = 0, l = imports.length, imp; i < l && (imp = imports[i]); i++) {
      // Skip nested imports.
      if (MATCHES.call(imp, `${IMPORT_SELECTOR} ${IMPORT_SELECTOR}`)) {
        continue;
      }
      importInfo.allImports.push(imp);
      promises.push(whenElementLoaded(imp).then((imp) => {
        importInfo.loadedImports.push(imp);
        return imp;
      }).catch((imp) => {
        importInfo.errorImports.push(imp);
        // Capture failures, always return imp.
        return imp;
      }));
    }
    // Return aggregated info.
    return Promise.all(promises).then(() => importInfo);
  }

  new Importer(document);

  // Fire the 'HTMLImportsLoaded' event when imports in document at load time
  // have loaded. This event is required to simulate the script blocking
  // behavior of native imports. A main document script that needs to be sure
  // imports have loaded should wait for this event.
  whenReady((detail) =>
    document.dispatchEvent(new CustomEvent('HTMLImportsLoaded', {
      cancelable: true,
      bubbles: true,
      detail: detail
    })));

  // exports
  scope.useNative = useNative;
  scope.whenReady = whenReady;

})(window.HTMLImports = (window.HTMLImports || {}));
