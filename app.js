(function () {
  'use strict';

  const state = {
    repoName: '',
    files: [],            // { path, isDir, size, entry? }
    tree: {},             // nested tree
    currentPath: '',      // '' for root
    currentFile: null,
  };

  const els = {
    zipInput: document.getElementById('zip-input'),
    zipInput2: document.getElementById('zip-input-2'),
    emptyState: document.getElementById('empty-state'),
    loadingState: document.getElementById('loading-state'),
    loadingMessage: document.getElementById('loading-message'),
    repoView: document.getElementById('repo-view'),
    topbarRepo: document.getElementById('topbar-repo'),
    repoNameLink: document.getElementById('repo-name-link'),
    repoTitleName: document.getElementById('repo-title-name'),
    fileCount: document.getElementById('file-count'),
    breadcrumbs: document.getElementById('breadcrumbs'),
    dirView: document.getElementById('dir-view'),
    fileView: document.getElementById('file-view'),
    readmeSection: document.getElementById('readme-section'),
    readmeContent: document.getElementById('readme-content'),
    searchInput: document.getElementById('search-input'),
    savedRepos: document.getElementById('saved-repos'),
    savedReposList: document.getElementById('saved-repos-list'),
  };

  // ---------- Zip handling ----------
  els.zipInput.addEventListener('change', handleFile);
  els.zipInput2.addEventListener('change', handleFile);

  // Drag & drop
  ['dragenter', 'dragover'].forEach(evt =>
    document.body.addEventListener(evt, e => {
      e.preventDefault();
      document.body.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    document.body.addEventListener(evt, e => {
      e.preventDefault();
      if (evt === 'dragleave' && e.target !== document.body) return;
      document.body.classList.remove('drag-over');
    })
  );
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadZipFromUpload(file);
  });

  function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (file) loadZipFromUpload(file);
  }

  async function loadZip(file, opts = {}) {
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = [];

      zip.forEach((relativePath, entry) => {
        if (entry.dir) {
          entries.push({
            path: relativePath.replace(/\/$/, ''),
            isDir: true,
            size: 0,
          });
        } else {
          entries.push({
            path: relativePath,
            isDir: false,
            size: entry._data ? entry._data.uncompressedSize : 0,
            entry: entry,
          });
        }
      });

      // Detect single root folder (common in zips)
      let rootPrefix = detectRootPrefix(entries);
      let repoName = (opts.repoName || file.name).replace(/\.zip$/i, '');
      if (rootPrefix) {
        repoName = rootPrefix.replace(/\/$/, '');
        entries.forEach(e => {
          e.path = e.path.substring(rootPrefix.length);
        });
      }

      const filtered = entries.filter(e => e.path && e.path !== '');

      state.files = filtered;
      state.repoName = repoName;
      state.tree = buildTree(filtered);
      state.currentPath = '';
      state.currentFile = null;

      els.emptyState.classList.add('hidden');
      els.loadingState.classList.add('hidden');
      els.repoView.classList.remove('hidden');
      els.topbarRepo.classList.remove('hidden');
      els.repoNameLink.textContent = repoName;
      els.repoTitleName.textContent = repoName;
      els.repoNameLink.href = '/' + encodePath(repoName);
      els.repoTitleName.href = '/' + encodePath(repoName);

      const fileCount = filtered.filter(f => !f.isDir).length;
      els.fileCount.textContent = `${fileCount} ファイル`;

      // Persist to server (skip when re-loaded from server)
      if (!opts.fromServer && opts.rawFile) {
        try {
          await fetch('/api/repo/' + encodeURIComponent(repoName), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/zip' },
            body: opts.rawFile,
          });
        } catch (e) {
          console.warn('zip保存に失敗しました', e);
        }
      }

      // Apply URL sub-path if user came in via /repo/path/...
      if (opts.applyUrl) applyUrlAfterLoad();

      pushUrl(opts.replaceUrl !== false);
      render();
      await loadReadmeIfPresent();
    } catch (err) {
      alert('Zipファイルの読み込みに失敗しました: ' + err.message);
      console.error(err);
      els.loadingState.classList.add('hidden');
      els.emptyState.classList.remove('hidden');
    }
  }

  async function loadZipFromUpload(file) {
    const buf = await file.arrayBuffer();
    return loadZip(file, { rawFile: buf, applyUrl: false, replaceUrl: false });
  }

  async function loadZipFromServer(repoName) {
    els.emptyState.classList.add('hidden');
    els.loadingState.classList.remove('hidden');
    els.loadingMessage.textContent = `${repoName} を読み込み中...`;
    try {
      const res = await fetch('/api/repo/' + encodeURIComponent(repoName));
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      const blob = await res.blob();
      const fakeFile = new File([blob], repoName + '.zip', { type: 'application/zip' });
      await loadZip(fakeFile, { fromServer: true, applyUrl: true, replaceUrl: true });
    } catch (err) {
      console.warn(err);
      els.loadingState.classList.add('hidden');
      els.emptyState.classList.remove('hidden');
      // Clear bad URL
      history.replaceState(null, '', '/');
      refreshSavedRepos();
    }
  }

  function detectRootPrefix(entries) {
    if (!entries.length) return '';
    const firstSeg = entries[0].path.split('/')[0];
    const allShare = entries.every(e => e.path.split('/')[0] === firstSeg);
    if (allShare && entries.some(e => e.path.includes('/'))) {
      return firstSeg + '/';
    }
    return '';
  }

  function buildTree(entries) {
    const root = { _children: {}, _isDir: true };
    entries.forEach(e => {
      const parts = e.path.split('/').filter(Boolean);
      let node = root;
      parts.forEach((part, i) => {
        const isLast = i === parts.length - 1;
        if (!node._children[part]) {
          node._children[part] = {
            _children: {},
            _isDir: isLast ? e.isDir : true,
            _entry: isLast && !e.isDir ? e : null,
            _name: part,
            _size: isLast && !e.isDir ? e.size : 0,
          };
        }
        node = node._children[part];
      });
    });
    return root;
  }

  function getNodeAtPath(path) {
    if (!path) return state.tree;
    const parts = path.split('/').filter(Boolean);
    let node = state.tree;
    for (const p of parts) {
      if (!node._children[p]) return null;
      node = node._children[p];
    }
    return node;
  }

  // ---------- URL routing ----------
  function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  function pushUrl(replace = false) {
    if (!state.repoName) return;
    let url = '/' + encodePath(state.repoName);
    const sub = state.currentFile || state.currentPath;
    if (sub) url += '/' + encodePath(sub);
    const fn = replace ? 'replaceState' : 'pushState';
    history[fn]({
      repo: state.repoName,
      path: state.currentPath,
      file: state.currentFile,
    }, '', url);
  }

  function readUrlPath() {
    const raw = window.location.pathname.replace(/^\/+/, '');
    if (!raw) return null;
    const parts = raw.split('/').map(decodeURIComponent);
    const repo = parts.shift();
    const sub = parts.join('/');
    return { repo, sub };
  }

  function applyUrlAfterLoad() {
    const u = readUrlPath();
    if (!u || !state.repoName) return;
    if (u.repo !== state.repoName) {
      pushUrl(true);
      return;
    }
    if (!u.sub) {
      state.currentPath = '';
      state.currentFile = null;
      return;
    }
    const node = getNodeAtPath(u.sub);
    if (!node) {
      state.currentPath = '';
      state.currentFile = null;
      pushUrl(true);
      return;
    }
    if (node._isDir) {
      state.currentPath = u.sub;
      state.currentFile = null;
    } else {
      state.currentFile = u.sub;
      state.currentPath = u.sub.split('/').slice(0, -1).join('/');
    }
  }

  window.addEventListener('popstate', () => {
    if (!state.repoName) return;
    applyUrlAfterLoad();
    render();
  });

  // ---------- Render ----------
  function render() {
    renderBreadcrumbs();
    if (state.currentFile) {
      renderFile();
    } else {
      renderDir();
    }
  }

  function renderBreadcrumbs() {
    const parts = [];
    parts.push(`<a data-path="">${escapeHtml(state.repoName)}</a>`);
    const segs = (state.currentFile || state.currentPath || '').split('/').filter(Boolean);
    let acc = '';
    segs.forEach((seg, i) => {
      acc = acc ? acc + '/' + seg : seg;
      const isLast = i === segs.length - 1;
      parts.push('<span class="sep">/</span>');
      if (isLast) {
        parts.push(`<span class="current">${escapeHtml(seg)}</span>`);
      } else {
        parts.push(`<a data-path="${escapeAttr(acc)}">${escapeHtml(seg)}</a>`);
      }
    });
    els.breadcrumbs.innerHTML = parts.join('');
    els.breadcrumbs.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        state.currentPath = a.dataset.path;
        state.currentFile = null;
        pushUrl();
        render();
      });
    });
  }

  function renderDir() {
    els.fileView.classList.add('hidden');
    els.dirView.classList.remove('hidden');

    const node = getNodeAtPath(state.currentPath);
    if (!node) {
      els.dirView.innerHTML = '<div class="empty-notice">フォルダが見つかりません</div>';
      return;
    }

    const search = els.searchInput.value.trim().toLowerCase();
    let children = Object.values(node._children);

    if (search) {
      children = children.filter(c => c._name.toLowerCase().includes(search));
    }

    children.sort((a, b) => {
      if (a._isDir !== b._isDir) return a._isDir ? -1 : 1;
      return a._name.localeCompare(b._name);
    });

    const rows = children.map(child => {
      const childPath = state.currentPath ? state.currentPath + '/' + child._name : child._name;
      const icon = child._isDir ? folderIcon() : fileIcon(child._name);
      const size = child._isDir ? '' : formatSize(child._size);
      return `
        <tr data-path="${escapeAttr(childPath)}" data-isdir="${child._isDir}">
          <td class="icon">${icon}</td>
          <td class="name"><a>${escapeHtml(child._name)}</a></td>
          <td class="size">${size}</td>
        </tr>`;
    }).join('');

    const upRow = state.currentPath ? `
      <tr data-up="1">
        <td class="icon">${folderIcon()}</td>
        <td class="name"><a>..</a></td>
        <td class="size"></td>
      </tr>` : '';

    els.dirView.innerHTML = `
      <table>
        <tbody>
          <tr class="header-row">
            <td colspan="3">${escapeHtml(state.currentPath || '/')}</td>
          </tr>
          ${upRow}
          ${rows || '<tr><td colspan="3" class="empty-notice">空のフォルダ</td></tr>'}
        </tbody>
      </table>
    `;

    els.dirView.querySelectorAll('tr[data-path]').forEach(tr => {
      tr.addEventListener('click', () => {
        const p = tr.dataset.path;
        const isDir = tr.dataset.isdir === 'true';
        if (isDir) {
          state.currentPath = p;
          state.currentFile = null;
        } else {
          state.currentFile = p;
        }
        pushUrl();
        render();
      });
    });
    const up = els.dirView.querySelector('tr[data-up]');
    if (up) {
      up.addEventListener('click', () => {
        const segs = state.currentPath.split('/').filter(Boolean);
        segs.pop();
        state.currentPath = segs.join('/');
        pushUrl();
        render();
      });
    }
  }

  async function renderFile() {
    els.dirView.classList.add('hidden');
    els.fileView.classList.remove('hidden');

    const node = getNodeAtPath(state.currentFile);
    if (!node || !node._entry) {
      els.fileView.innerHTML = '<div class="empty-notice">ファイルが見つかりません</div>';
      return;
    }

    const entry = node._entry.entry;
    const name = node._name;
    const size = node._size;

    els.fileView.innerHTML = `
      <div class="file-view-header">
        <div class="info">
          <strong>${escapeHtml(name)}</strong>
          <span>${formatSize(size)}</span>
        </div>
        <div class="info file-actions">
          <button type="button" class="file-action-btn" data-action="copy" title="ファイルの内容をコピー" disabled>
            <svg height="16" viewBox="0 0 16 16" width="16" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>
            <span class="copy-label">コピー</span>
          </button>
          <button type="button" class="file-action-btn" data-action="download" title="このファイルをダウンロード">
            <svg height="16" viewBox="0 0 16 16" width="16" aria-hidden="true"><path fill="currentColor" d="M2.75 14A1.75 1.75 0 011 12.25v-2.5a.75.75 0 011.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-2.5a.75.75 0 011.5 0v2.5A1.75 1.75 0 0113.25 14z"/><path fill="currentColor" d="M7.25 7.689V2a.75.75 0 011.5 0v5.689l1.97-1.969a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 6.78a.75.75 0 011.06-1.06z"/></svg>
            <span>ダウンロード</span>
          </button>
        </div>
      </div>
      <div class="file-content"><div class="empty-notice">読み込み中...</div></div>
    `;

    const contentEl = els.fileView.querySelector('.file-content');
    const copyBtn = els.fileView.querySelector('[data-action="copy"]');
    const downloadBtn = els.fileView.querySelector('[data-action="download"]');

    downloadBtn.addEventListener('click', async () => {
      const blob = await entry.async('blob');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    let cachedText = null;
    copyBtn.addEventListener('click', async () => {
      if (cachedText == null) return;
      try {
        await navigator.clipboard.writeText(cachedText);
        const label = copyBtn.querySelector('.copy-label');
        const original = label.textContent;
        label.textContent = 'コピーしました';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          label.textContent = original;
          copyBtn.classList.remove('copied');
        }, 1500);
      } catch (err) {
        alert('コピーに失敗しました: ' + err.message);
      }
    });

    function enableCopy(text) {
      cachedText = text;
      copyBtn.disabled = false;
    }

    if (isImage(name)) {
      const blob = await entry.async('blob');
      const url = URL.createObjectURL(blob);
      contentEl.innerHTML = `<div class="image-preview"><img src="${url}" alt="${escapeAttr(name)}" /></div>`;
      return;
    }

    if (isBinary(name)) {
      contentEl.innerHTML = `<div class="binary-notice">バイナリファイルのプレビューには対応していません</div>`;
      return;
    }

    try {
      const text = await entry.async('string');
      enableCopy(text);

      if (/\.md$/i.test(name)) {
        contentEl.innerHTML = `<div class="markdown-body">${marked.parse(text)}</div>`;
        contentEl.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
        return;
      }

      const lang = guessLang(name);
      let highlighted;
      try {
        highlighted = lang ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
                           : hljs.highlightAuto(text).value;
      } catch (_) {
        highlighted = escapeHtml(text);
      }

      const lines = highlighted.split('\n');
      const rows = lines.map((line, i) => `
        <tr id="L${i + 1}">
          <td class="line-num">${i + 1}</td>
          <td class="line-content">${line || ' '}</td>
        </tr>
      `).join('');

      contentEl.innerHTML = `<pre><table class="code-table hljs"><tbody>${rows}</tbody></table></pre>`;
    } catch (err) {
      contentEl.innerHTML = `<div class="binary-notice">ファイル読み込みエラー: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadReadmeIfPresent() {
    const candidates = ['README.md', 'README.MD', 'Readme.md', 'readme.md'];
    let readmeNode = null;
    for (const c of candidates) {
      const n = state.tree._children[c];
      if (n && n._entry) { readmeNode = n; break; }
    }
    if (!readmeNode) {
      els.readmeSection.classList.add('hidden');
      return;
    }
    try {
      const text = await readmeNode._entry.entry.async('string');
      els.readmeContent.innerHTML = marked.parse(text);
      els.readmeContent.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
      els.readmeSection.classList.remove('hidden');
    } catch (e) {
      els.readmeSection.classList.add('hidden');
    }
  }

  els.searchInput.addEventListener('input', () => {
    if (!state.currentFile) renderDir();
  });

  // ---------- Saved repos list ----------
  async function refreshSavedRepos() {
    try {
      const res = await fetch('/api/repos');
      if (!res.ok) return;
      const data = await res.json();
      const items = data.repos || [];
      if (!items.length) {
        els.savedRepos.classList.add('hidden');
        return;
      }
      els.savedRepos.classList.remove('hidden');
      els.savedReposList.innerHTML = items.map(r => `
        <li data-name="${escapeAttr(r.name)}">
          <a class="repo-link" href="/${encodeURIComponent(r.name)}" data-name="${escapeAttr(r.name)}">
            <svg height="16" viewBox="0 0 16 16" width="16" aria-hidden="true"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z"/></svg>
            <span>${escapeHtml(r.name)}</span>
          </a>
          <span class="meta">${formatSize(r.size)}</span>
          <button type="button" class="delete-btn" data-name="${escapeAttr(r.name)}" title="削除">×</button>
        </li>
      `).join('');

      els.savedReposList.querySelectorAll('.repo-link').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const name = a.dataset.name;
          history.pushState(null, '', '/' + encodeURIComponent(name));
          loadZipFromServer(name);
        });
      });
      els.savedReposList.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async e => {
          e.stopPropagation();
          const name = btn.dataset.name;
          if (!confirm(`${name} を削除しますか?`)) return;
          await fetch('/api/repo/' + encodeURIComponent(name), { method: 'DELETE' });
          refreshSavedRepos();
        });
      });
    } catch (e) {
      console.warn('保存済みリポジトリの取得に失敗しました', e);
    }
  }

  // ---------- Bootstrap ----------
  async function bootstrap() {
    const u = readUrlPath();
    if (u && u.repo) {
      await loadZipFromServer(u.repo);
      return;
    }
    refreshSavedRepos();
  }
  bootstrap();

  // ---------- Helpers ----------
  function folderIcon() {
    return `<svg class="icon-folder" height="16" viewBox="0 0 16 16" width="16"><path fill="currentColor" d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3h-6.5a.25.25 0 01-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7h-3.5z"/></svg>`;
  }
  function fileIcon(name) {
    const color = fileColor(name || '');
    return `<svg class="icon-file" style="color:${color}" height="16" viewBox="0 0 16 16" width="16"><path fill="currentColor" d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0112.25 16h-8.5A1.75 1.75 0 012 14.25V1.75zm1.75-.25a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6h-2.75A1.75 1.75 0 018 4.25V1.5H3.75z"/></svg>`;
  }

  // GitLab/GitHub-style colors per file extension
  const FILE_COLORS = {
    js: '#f1e05a', mjs: '#f1e05a', cjs: '#f1e05a', jsx: '#f1e05a',
    ts: '#3178c6', tsx: '#3178c6',
    py: '#3572A5', rb: '#701516',
    go: '#00ADD8', rs: '#dea584',
    java: '#b07219', kt: '#A97BFF', swift: '#F05138',
    c: '#555555', h: '#555555',
    cpp: '#f34b7d', cc: '#f34b7d', hpp: '#f34b7d',
    cs: '#178600', php: '#4F5D95',
    html: '#e34c26', htm: '#e34c26',
    css: '#563d7c', scss: '#c6538c', less: '#1d365d',
    json: '#cb8520', xml: '#0060ac', svg: '#ff9800',
    yml: '#cb171e', yaml: '#cb171e', toml: '#9c4221', ini: '#9c4221',
    md: '#083fa1', txt: '#6e7681', log: '#6e7681',
    sh: '#89e051', bash: '#89e051', zsh: '#89e051',
    sql: '#e38c00',
    png: '#a371f7', jpg: '#a371f7', jpeg: '#a371f7', gif: '#a371f7', webp: '#a371f7', bmp: '#a371f7', ico: '#a371f7',
    pdf: '#cf222e',
    zip: '#9b6a00', tar: '#9b6a00', gz: '#9b6a00', '7z': '#9b6a00', rar: '#9b6a00',
    lock: '#a371f7',
  };

  function fileColor(name) {
    const lower = name.toLowerCase();
    if (lower === 'dockerfile') return '#384d54';
    if (lower === 'makefile') return '#427819';
    if (lower === 'license' || lower === 'license.txt' || lower === 'license.md') return '#cf222e';
    if (lower === 'readme' || lower === 'readme.md') return '#083fa1';
    const ext = lower.split('.').pop();
    return FILE_COLORS[ext] || '#57606a';
  }

  function formatSize(bytes) {
    if (bytes === 0 || bytes == null) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function isImage(name) {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name);
  }

  function isBinary(name) {
    return /\.(zip|tar|gz|7z|rar|exe|dll|so|bin|dat|pdf|mp[34]|wav|ogg|mov|avi|woff2?|ttf|eot|otf|class|jar|pyc)$/i.test(name);
  }

  function guessLang(name) {
    const map = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
      java: 'java', kt: 'kotlin', swift: 'swift',
      c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
      cs: 'csharp', php: 'php',
      html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
      css: 'css', scss: 'scss', less: 'less',
      json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
      sh: 'bash', bash: 'bash', zsh: 'bash',
      sql: 'sql', md: 'markdown',
      dockerfile: 'dockerfile',
    };
    const ext = name.split('.').pop().toLowerCase();
    if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
    return map[ext] || null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
})();
